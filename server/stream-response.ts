const BACKUP_STREAM_IDLE_TIMEOUT_MS = 60_000;

export const streamBackupArchive = (
  archive: {
    archivePath: string;
    cleanup: () => Promise<void>;
  },
  releaseBackupLock: () => void,
  idleTimeoutMs = BACKUP_STREAM_IDLE_TIMEOUT_MS,
) => {
  const source = Bun.file(archive.archivePath).stream();
  const reader = source.getReader();
  let cleanupTask: Promise<void> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const clearIdleTimer = () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };
  const cleanup = async () => {
    closed = true;
    clearIdleTimer();
    cleanupTask ??= (async () => {
      try {
        await archive.cleanup().catch(() => {});
      } finally {
        releaseBackupLock();
      }
    })();
    await cleanupTask;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      clearIdleTimer();
      try {
        const result = await reader.read();
        if (result.done) {
          reader.releaseLock();
          await cleanup();
          controller.close();
          return;
        }
        // Read only when the consumer requests more data. The stream's default
        // one-chunk queue bounds read-ahead when a client applies backpressure.
        controller.enqueue(result.value);
        if (!closed && idleTimeoutMs > 0) {
          idleTimer = setTimeout(() => {
            const timeoutError = new Error("备份下载空闲超时");
            try {
              controller.error(timeoutError);
            } catch {
              // Ignore if stream is already closed or errored.
            }
            void reader
              .cancel(timeoutError)
              .catch(() => {})
              .finally(() => {
                try {
                  reader.releaseLock();
                } catch {
                  // Ignore if already released.
                }
                void cleanup();
              });
          }, idleTimeoutMs);
        }
      } catch (error) {
        controller.error(error);
        await reader.cancel(error).catch(() => {});
        reader.releaseLock();
        await cleanup();
      }
    },
    cancel: async (reason) => {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
        await cleanup();
      }
    },
  });
};

export const openStableFileResponseStream = async (filePath: string) => {
  const reader = Bun.file(filePath).stream().getReader();
  let firstChunk: Awaited<ReturnType<typeof reader.read>>;
  try {
    // Opening the stream and reading its first chunk pins the current file
    // before the storage mutation lock is released. Atomic replacement can
    // then proceed without changing the bytes served by this response.
    firstChunk = await reader.read();
  } catch (error) {
    reader.releaseLock();
    throw error;
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (firstChunk.done) {
        reader.releaseLock();
        controller.close();
        return;
      }
      controller.enqueue(firstChunk.value);
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          reader.releaseLock();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });
};
