export const streamBackupArchive = (
  archive: {
    archivePath: string;
    cleanup: () => Promise<void>;
  },
  releaseBackupLock: () => void,
) => {
  const source = Bun.file(archive.archivePath).stream();
  const reader = source.getReader();
  let cleanupTask: Promise<void> | undefined;
  const cleanup = async () => {
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
