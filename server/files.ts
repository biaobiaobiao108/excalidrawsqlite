import fs from "node:fs";
import path from "node:path";

import {
  BACKUP_STAGING_DIR_PREFIX,
  FILE_ID_PATTERN,
  ORPHAN_FILE_CLEANUP_BATCH_SIZE,
  ORPHAN_FILE_GRACE_MS,
  STALE_FILE_ARTIFACT_MS,
  UNTRACKED_FILE_CLEANUP_BATCH_SIZE,
} from "./config";
import { randomHex } from "./crypto";
import { HttpError } from "./errors";
import { isRecord, validateId } from "./validation";

import type { ServerRuntime } from "./types";

const thumbnailWriteLocks = new Map<string, Promise<void>>();
type StorageMutationWaiter = {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
  started: boolean;
};

type StorageMutationQueue = {
  active: boolean;
  waiters: StorageMutationWaiter[];
};

const storageMutationLocks = new WeakMap<ServerRuntime, StorageMutationQueue>();

const startNextStorageMutation = (
  runtime: ServerRuntime,
  queue: StorageMutationQueue,
) => {
  if (queue.active) {
    return;
  }
  const waiter = queue.waiters.shift();
  if (!waiter) {
    if (storageMutationLocks.get(runtime) === queue) {
      storageMutationLocks.delete(runtime);
    }
    return;
  }

  queue.active = true;
  waiter.started = true;
  if (waiter.abort && waiter.signal) {
    waiter.signal.removeEventListener("abort", waiter.abort);
  }
  void Promise.resolve()
    .then(waiter.task)
    .then(waiter.resolve, waiter.reject)
    .finally(() => {
      queue.active = false;
      startNextStorageMutation(runtime, queue);
    });
};

export const withStorageMutationLock = async <T>(
  runtime: ServerRuntime,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  if (signal?.aborted) {
    throw new DOMException("The request was aborted", "AbortError");
  }
  let queue = storageMutationLocks.get(runtime);
  if (!queue) {
    queue = { active: false, waiters: [] };
    storageMutationLocks.set(runtime, queue);
  }

  return await new Promise<T>((resolve, reject) => {
    const waiter: StorageMutationWaiter = {
      task,
      resolve: (value) => resolve(value as T),
      reject,
      signal,
      started: false,
    };
    if (signal) {
      waiter.abort = () => {
        if (waiter.started) {
          return;
        }
        const index = queue!.waiters.indexOf(waiter);
        if (index < 0) {
          return;
        }
        queue!.waiters.splice(index, 1);
        signal.removeEventListener("abort", waiter.abort!);
        reject(new DOMException("The request was aborted", "AbortError"));
        startNextStorageMutation(runtime, queue!);
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
    }
    queue!.waiters.push(waiter);
    startNextStorageMutation(runtime, queue!);
  });
};

export const withThumbnailWriteLock = async <T>(
  thumbnailId: string,
  task: () => Promise<T>,
): Promise<T> => {
  const previous = thumbnailWriteLocks.get(thumbnailId) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  thumbnailWriteLocks.set(thumbnailId, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (thumbnailWriteLocks.get(thumbnailId) === current) {
      thumbnailWriteLocks.delete(thumbnailId);
    }
  }
};

export const getFilePath = (runtime: ServerRuntime, id: string) => {
  const base = path.resolve(runtime.filesDir);
  const filePath = path.resolve(base, id);
  if (filePath !== base && !filePath.startsWith(`${base}${path.sep}`)) {
    throw new HttpError(400, "INVALID_ID", "无效的文件路径");
  }
  return filePath;
};

export const fileExists = (filePath: string) => Bun.file(filePath).exists();

type AtomicFileWrite = {
  restore: () => Promise<void>;
  cleanup: () => Promise<void>;
};

const getFileTooLargeError = (maxBytes: number) => {
  const limit = maxBytes / (1024 * 1024);
  const formattedLimit = Number.isInteger(limit)
    ? `${limit} MiB`
    : `${maxBytes} 字节`;
  return new HttpError(
    413,
    "FILE_TOO_LARGE",
    `单个文件不能超过 ${formattedLimit}`,
  );
};

const finalizeAtomicFileWrite = async (
  filePath: string,
  tempPath: string,
): Promise<AtomicFileWrite> => {
  const backupPath = `${filePath}.${randomHex(8)}.bak`;
  const hadExistingFile = await fileExists(filePath);

  try {
    if (hadExistingFile) {
      await fs.promises.copyFile(filePath, backupPath);
    }

    try {
      await fs.promises.rename(tempPath, filePath);
    } catch (error: any) {
      // Windows does not replace an existing file with rename(). Keep the
      // atomic path on POSIX and use a safe replacement fallback on Windows.
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") {
        throw error;
      }
      await fs.promises.rm(filePath, { force: true });
      try {
        await fs.promises.rename(tempPath, filePath);
      } catch (replacementError) {
        if (hadExistingFile) {
          await fs.promises.copyFile(backupPath, filePath);
        }
        throw replacementError;
      }
    }
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true });
    // If replacement and rollback both failed, keep the only surviving copy.
    if (!(await fileExists(backupPath)) || (await fileExists(filePath))) {
      await fs.promises.rm(backupPath, { force: true });
    }
    throw error;
  }

  return {
    restore: async () => {
      if (hadExistingFile) {
        await fs.promises.copyFile(backupPath, filePath);
      } else {
        await fs.promises.rm(filePath, { force: true });
      }
      await fs.promises.rm(backupPath, { force: true });
    },
    cleanup: () => fs.promises.rm(backupPath, { force: true }),
  };
};

const writeFileAtomically = async (
  filePath: string,
  data: Uint8Array,
): Promise<AtomicFileWrite> => {
  const tempPath = `${filePath}.${randomHex(8)}.tmp`;
  try {
    await Bun.write(tempPath, data);
    return await finalizeAtomicFileWrite(filePath, tempPath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true });
    throw error;
  }
};

type PreparedFile = {
  byteLength: number;
  sha256: string;
  data?: Uint8Array;
  tempPath?: string;
};

const upsertPreparedFile = async (
  runtime: ServerRuntime,
  id: string,
  mimeType: string,
  prepared: PreparedFile,
  createdAt?: number,
  updatedAt?: number,
  assertCanWrite?: () => void,
) => {
  return withStorageMutationLock(runtime, async () => {
    assertCanWrite?.();
    if (prepared.byteLength > runtime.config.maxFileBytes) {
      throw getFileTooLargeError(runtime.config.maxFileBytes);
    }
    if (!prepared.data && !prepared.tempPath) {
      throw new Error("文件内容未准备完成");
    }

    const filePath = getFilePath(runtime, id);
    const now = Number.isFinite(updatedAt) ? Number(updatedAt) : Date.now();
    const previous = runtime.db
      .query(
        "SELECT created_at, updated_at, byte_size, sha256, mime_type FROM files WHERE id = ?",
      )
      .get(id) as {
      created_at: number;
      updated_at: number;
      byte_size: number;
      sha256: string;
      mime_type: string;
    } | null;

    if (
      previous &&
      previous.byte_size === prepared.byteLength &&
      previous.sha256 === prepared.sha256 &&
      previous.mime_type.toLowerCase() === mimeType.toLowerCase() &&
      (await fileExists(filePath))
    ) {
      assertCanWrite?.();
      // An identical upload still renews the orphan grace period; explicit
      // thumbnail versions retain their monotonic ordering instead.
      const nextUpdatedAt = Math.max(previous.updated_at, now);
      if (nextUpdatedAt !== previous.updated_at) {
        runtime.db.run("UPDATE files SET updated_at = ? WHERE id = ?", [
          nextUpdatedAt,
          id,
        ]);
      }
      return {
        id,
        mimeType,
        byteSize: previous.byte_size,
        sha256: previous.sha256,
        createdAt: previous.created_at,
        updatedAt: nextUpdatedAt,
      };
    }

    const atomicWrite = prepared.tempPath
      ? await finalizeAtomicFileWrite(filePath, prepared.tempPath)
      : await writeFileAtomically(filePath, prepared.data!);
    try {
      assertCanWrite?.();
      runtime.db.run(
        `INSERT INTO files
           (id, storage_path, mime_type, byte_size, sha256, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           storage_path = excluded.storage_path,
           mime_type = excluded.mime_type,
           byte_size = excluded.byte_size,
           sha256 = excluded.sha256,
           updated_at = excluded.updated_at`,
        [
          id,
          id,
          mimeType,
          prepared.byteLength,
          prepared.sha256,
          previous?.created_at || createdAt || now,
          now,
        ],
      );
    } catch (error) {
      try {
        await atomicWrite.restore();
      } catch (restoreError) {
        console.info("[Files] Failed to roll back file after database error", {
          filePath,
          error: restoreError,
        });
        throw new Error("文件写入回滚失败", { cause: restoreError });
      }
      throw error;
    }

    await atomicWrite.cleanup().catch((error) => {
      console.info("[Files] Failed to remove temporary backup", {
        filePath,
        error,
      });
    });

    return {
      id,
      mimeType,
      byteSize: prepared.byteLength,
      sha256: prepared.sha256,
      createdAt: previous?.created_at || createdAt || now,
      updatedAt: now,
    };
  });
};

export const stageRequestBodyToFile = async (
  runtime: ServerRuntime,
  id: string,
  req: Request,
): Promise<PreparedFile> => {
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > runtime.config.maxFileBytes) {
    throw getFileTooLargeError(runtime.config.maxFileBytes);
  }
  if (!req.body) {
    throw new HttpError(400, "EMPTY_FILE", "文件内容不能为空");
  }

  const filePath = getFilePath(runtime, id);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomHex(8)}.tmp`;
  const activeTempPath = path.resolve(tempPath);
  const reservedBytes = await runtime.bodyMemoryBudget.acquire(
    runtime.config.maxFileBytes,
    req.signal,
  );
  runtime.activeFileArtifacts.add(activeTempPath);
  let writer: ReturnType<ReturnType<typeof Bun.file>["writer"]> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    reader = req.body.getReader();
    writer = Bun.file(tempPath).writer({ highWaterMark: 64 * 1024 });
    const hash = new Bun.CryptoHasher("sha256");
    let byteLength = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      byteLength += result.value.byteLength;
      if (byteLength > runtime.config.maxFileBytes) {
        await reader.cancel();
        throw getFileTooLargeError(runtime.config.maxFileBytes);
      }
      hash.update(result.value);
      await writer.write(result.value);
    }
    if (!byteLength) {
      throw new HttpError(400, "EMPTY_FILE", "文件内容不能为空");
    }
    await writer.end();
    return {
      tempPath,
      byteLength,
      sha256: hash.digest("hex"),
    };
  } catch (error) {
    try {
      await writer?.end();
    } catch {
      // Closing a failed sink must not prevent temporary-file cleanup.
    }
    await fs.promises.rm(tempPath, { force: true });
    runtime.activeFileArtifacts.delete(activeTempPath);
    throw error;
  } finally {
    try {
      reader?.releaseLock();
    } finally {
      runtime.bodyMemoryBudget.release(reservedBytes);
    }
  }
};

export const upsertStagedFile = async (
  runtime: ServerRuntime,
  id: string,
  mimeType: string,
  prepared: PreparedFile,
  createdAt?: number,
  updatedAt?: number,
  assertCanWrite?: () => void,
) => {
  try {
    return await upsertPreparedFile(
      runtime,
      id,
      mimeType,
      prepared,
      createdAt,
      updatedAt,
      assertCanWrite,
    );
  } finally {
    if (prepared.tempPath) {
      try {
        await fs.promises.rm(prepared.tempPath, { force: true });
      } finally {
        runtime.activeFileArtifacts.delete(path.resolve(prepared.tempPath));
      }
    }
  }
};

export const extractFileIds = (elements: unknown[]) => {
  const ids = new Set<string>();
  for (const element of elements) {
    if (
      isRecord(element) &&
      element.type === "image" &&
      element.isDeleted !== true &&
      typeof element.fileId === "string"
    ) {
      ids.add(validateId(element.fileId, "file"));
    }
  }
  return [...ids];
};

export const assertReferencedFilesExist = async (
  runtime: ServerRuntime,
  fileIds: string[],
) => {
  const rowsById = new Map<string, { storage_path: string | null }>();
  const queryChunkSize = 500;
  for (let offset = 0; offset < fileIds.length; offset += queryChunkSize) {
    const chunk = fileIds.slice(offset, offset + queryChunkSize);
    if (!chunk.length) {
      continue;
    }
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = runtime.db
      .query(
        `SELECT id, storage_path FROM files WHERE id IN (${placeholders})`,
      )
      .all(...chunk) as Array<{
      id: string;
      storage_path: string | null;
    }>;
    for (const row of rows) {
      rowsById.set(row.id, row);
    }
  }

  for (const fileId of fileIds) {
    const row = rowsById.get(fileId);
    if (
      !row?.storage_path ||
      !(await fileExists(getFilePath(runtime, fileId)))
    ) {
      throw new HttpError(422, "MISSING_FILE", "画板引用的图片尚未上传完成");
    }
  }
};

const sceneFileReferenceStatements = new WeakMap<
  ServerRuntime,
  {
    list: ReturnType<ServerRuntime["db"]["query"]>;
    remove: ReturnType<ServerRuntime["db"]["query"]>;
    insert: ReturnType<ServerRuntime["db"]["query"]>;
  }
>();

const getSceneFileReferenceStatements = (runtime: ServerRuntime) => {
  let statements = sceneFileReferenceStatements.get(runtime);
  if (!statements) {
    statements = {
      list: runtime.db.query(
        "SELECT file_id FROM scene_files WHERE scene_id = ?",
      ),
      remove: runtime.db.query(
        "DELETE FROM scene_files WHERE scene_id = ? AND file_id = ?",
      ),
      insert: runtime.db.query(
        "INSERT OR IGNORE INTO scene_files (scene_id, file_id) VALUES (?, ?)",
      ),
    };
    sceneFileReferenceStatements.set(runtime, statements);
  }
  return statements;
};

export const syncSceneFileReferences = (
  runtime: ServerRuntime,
  sceneId: string,
  fileIds: string[],
) => {
  const statements = getSceneFileReferenceStatements(runtime);
  const existingFileIds = new Set(
    (
      statements.list.all(sceneId) as Array<{ file_id: string }>
    ).map((row) => row.file_id),
  );
  const nextFileIds = new Set(fileIds);

  for (const fileId of existingFileIds) {
    if (!nextFileIds.has(fileId)) {
      statements.remove.run(sceneId, fileId);
    }
  }
  for (const fileId of nextFileIds) {
    if (!existingFileIds.has(fileId)) {
      statements.insert.run(sceneId, fileId);
    }
  }
};

export const cleanupOrphanedFiles = async (runtime: ServerRuntime) => {
  await withStorageMutationLock(runtime, async () => {
    const cutoff = Date.now() - ORPHAN_FILE_GRACE_MS;
    const rows = runtime.db
      .query(
        `SELECT id, storage_path, updated_at FROM files
         WHERE updated_at < ?
           AND NOT EXISTS (SELECT 1 FROM scene_files WHERE scene_files.file_id = files.id)
           AND NOT EXISTS (SELECT 1 FROM scenes WHERE scenes.thumbnail_file_id = files.id)
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all(cutoff, ORPHAN_FILE_CLEANUP_BATCH_SIZE) as Array<{
      id: string;
      storage_path: string | null;
      updated_at: number;
    }>;

    for (const row of rows) {
      const filePath = getFilePath(runtime, row.id);
      const quarantinePath = `${filePath}.${randomHex(8)}.gc`;
      let quarantined = false;
      try {
        if (row.storage_path && (await fileExists(filePath))) {
          await fs.promises.rename(filePath, quarantinePath);
          quarantined = true;
        }
        const deleted = runtime.db.run(
          `DELETE FROM files
           WHERE id = ?
             AND updated_at = ?
             AND NOT EXISTS (SELECT 1 FROM scene_files WHERE scene_files.file_id = files.id)
             AND NOT EXISTS (SELECT 1 FROM scenes WHERE scenes.thumbnail_file_id = files.id)`,
          [row.id, row.updated_at],
        );
        if (deleted.changes && quarantined) {
          await fs.promises.rm(quarantinePath, { force: true });
        } else if (quarantined) {
          await fs.promises.rename(quarantinePath, filePath);
        }
      } catch (error) {
        if (quarantined) {
          await fs.promises
            .rename(quarantinePath, filePath)
            .catch(() => undefined);
        }
        console.info("[Files] 附件垃圾回收失败，保留原文件", {
          id: row.id,
          error,
        });
      }
    }
  });
};

export const cleanupUntrackedFiles = async (runtime: ServerRuntime) => {
  await withStorageMutationLock(runtime, async () => {
    const knownFileIds = new Set(
      (
        runtime.db.query("SELECT id FROM files").all() as Array<{ id: string }>
      ).map((row) => row.id),
    );
    const cutoff = Date.now() - ORPHAN_FILE_GRACE_MS;
    let cleaned = 0;
    for (const entry of await fs.promises.readdir(runtime.filesDir, {
      withFileTypes: true,
    })) {
      if (
        cleaned >= UNTRACKED_FILE_CLEANUP_BATCH_SIZE ||
        !entry.isFile() ||
        !FILE_ID_PATTERN.test(entry.name) ||
        knownFileIds.has(entry.name)
      ) {
        continue;
      }
      const filePath = path.join(runtime.filesDir, entry.name);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) {
        await fs.promises.rm(filePath, { force: true });
        cleaned += 1;
        console.info("[Files] 清理未跟踪附件", { filePath });
      }
    }
  });
};

const fileMatchesMetadata = async (
  filePath: string,
  metadata: { byte_size: number; sha256: string },
) => {
  const file = Bun.file(filePath);
  if (!(await file.exists()) || file.size !== metadata.byte_size) {
    return false;
  }

  const hasher = new Bun.CryptoHasher("sha256");
  const reader = file.stream().getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      hasher.update(result.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return hasher.digest("hex") === metadata.sha256;
};

const recoverInterruptedFileReplacements = async (runtime: ServerRuntime) => {
  const entries = await fs.promises.readdir(runtime.filesDir, {
    withFileTypes: true,
  });
  const backups = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = /^([A-Za-z0-9_-]{1,128})\.[a-f0-9]{16}\.bak$/i.exec(
        entry.name,
      );
      return match ? { id: match[1], name: entry.name } : null;
    })
    .filter((entry): entry is { id: string; name: string } => entry !== null);
  const backupsWithTime = await Promise.all(
    backups.map(async (backup) => ({
      ...backup,
      mtimeMs:
        (await fs.promises
          .stat(path.join(runtime.filesDir, backup.name))
          .catch(() => null))?.mtimeMs || 0,
    })),
  );
  backupsWithTime.sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const { id, name } of backupsWithTime) {
    const filePath = getFilePath(runtime, id);
    const backupPath = path.join(runtime.filesDir, name);
    const metadata = runtime.db
      .query("SELECT byte_size, sha256 FROM files WHERE id = ?")
      .get(id) as { byte_size: number; sha256: string } | null;
    const targetExists = await fileExists(filePath);

    if (metadata && targetExists) {
      if (await fileMatchesMetadata(filePath, metadata)) {
        // The database commit completed before the process stopped; this is
        // only the old copy left behind by the atomic replacement.
        await fs.promises.rm(backupPath, { force: true });
        continue;
      }
      if (!(await fileMatchesMetadata(backupPath, metadata))) {
        // Neither copy agrees with the committed row. Keep the backup for
        // manual recovery rather than deleting the only potentially useful
        // copy during stale-artifact cleanup.
        continue;
      }

      // Restore through the same replacement path as uploads. The original
      // backup remains until the restored bytes have been verified against
      // SQLite, so another interruption can retry safely.
      const restoreTempPath = `${filePath}.${randomHex(8)}.tmp`;
      try {
        await fs.promises.copyFile(backupPath, restoreTempPath);
        const atomicWrite = await finalizeAtomicFileWrite(
          filePath,
          restoreTempPath,
        );
        if (await fileMatchesMetadata(filePath, metadata)) {
          await atomicWrite.cleanup();
          await fs.promises.rm(backupPath, { force: true });
          console.info("[Files] 恢复数据库版本的附件", { filePath });
        }
      } catch (error) {
        await fs.promises.rm(restoreTempPath, { force: true }).catch(() => {});
        console.info("[Files] 附件内容恢复失败，保留备份", {
          backupPath,
          error,
        });
      }
      continue;
    }

    if (targetExists) {
      continue;
    }

    if (metadata && !(await fileMatchesMetadata(backupPath, metadata))) {
      // Do not install bytes that would disagree with the row clients will
      // receive from SQLite. Leave the artifact intact for later inspection.
      continue;
    }
    try {
      await fs.promises.rename(backupPath, filePath);
      console.info("[Files] 恢复中断替换的附件", { filePath });
    } catch (error: any) {
      if (error?.code === "ENOENT" && (await fileExists(filePath))) {
        continue;
      }
      // Keep an unrecoverable backup in place for a later retry or manual
      // recovery. The stale-artifact pass below must not delete it.
      console.info("[Files] 附件备份恢复失败，保留备份", {
        backupPath,
        error,
      });
    }
  }
};

export const cleanupStaleFileArtifacts = async (runtime: ServerRuntime) => {
  // Serialize replacement recovery with uploads so cleanup cannot observe the
  // brief Windows replace window between removing the destination and renaming it.
  await withStorageMutationLock(runtime, async () => {
    await recoverInterruptedFileReplacements(runtime);
  });
  const cutoff = Date.now() - STALE_FILE_ARTIFACT_MS;
  const dbDirectory = path.dirname(runtime.dbPath);
  const directories = [
    {
      directory: runtime.filesDir,
      pattern: /\.(?:tmp|bak|gc)$/,
      staleOnly: true,
    },
    {
      // A partially written artifact cannot be a deliberate copy, so an
      // interrupted process may be cleaned up immediately.
      directory: dbDirectory,
      pattern:
        /^excalidraw-(?:backup-.*\.db|full-backup-.*\.tar)\.[A-Za-z0-9]+\.tmp$/,
      staleOnly: false,
    },
    {
      // Finished backups can be copied into data/ by an operator. Only reclaim
      // them once they are older than the grace period, so a backup that simply
      // lost its in-memory registration is not deleted on the next restart.
      directory: dbDirectory,
      pattern: /^excalidraw-(?:backup-.*\.db|full-backup-.*\.tar)$/,
      staleOnly: true,
    },
  ];
  for (const { directory, pattern, staleOnly } of directories) {
    const entries = await fs.promises.readdir(directory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || !pattern.test(entry.name)) {
        continue;
      }
      const filePath = path.join(directory, entry.name);
      const resolvedPath = path.resolve(filePath);
      if (
        runtime.activeBackupArtifacts.has(resolvedPath) ||
        runtime.activeFileArtifacts.has(resolvedPath)
      ) {
        continue;
      }
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (stat && (!staleOnly || stat.mtimeMs < cutoff)) {
        if (/\.bak$/i.test(entry.name)) {
          const backupMatch = /^([A-Za-z0-9_-]{1,128})\.[a-f0-9]{16}\.bak$/i.exec(
            entry.name,
          );
          if (
            backupMatch &&
            !(await fileExists(getFilePath(runtime, backupMatch[1])))
          ) {
            continue;
          }
          if (backupMatch) {
            const metadata = runtime.db
              .query("SELECT byte_size, sha256 FROM files WHERE id = ?")
              .get(backupMatch[1]) as {
              byte_size: number;
              sha256: string;
            } | null;
            if (
              metadata &&
              !(await fileMatchesMetadata(
                getFilePath(runtime, backupMatch[1]),
                metadata,
              ))
            ) {
              continue;
            }
          }
        }
        await fs.promises.rm(filePath, { force: true });
        console.info("[Files] 清理过期临时附件", { filePath });
      }
    }
  }

  // A staging directory only exists while a full backup is being written. A
  // directory left behind belongs to an interrupted run and still holds hard
  // links to every attachment, so reclaim it instead of leaking disk space.
  for (const entry of await fs.promises.readdir(dbDirectory, {
    withFileTypes: true,
  })) {
    if (
      !entry.isDirectory() ||
      !entry.name.startsWith(BACKUP_STAGING_DIR_PREFIX)
    ) {
      continue;
    }
    const stagingPath = path.join(dbDirectory, entry.name);
    if (runtime.activeBackupArtifacts.has(path.resolve(stagingPath))) {
      continue;
    }
    await fs.promises.rm(stagingPath, { recursive: true, force: true });
    console.info("[Files] 清理备份暂存目录", { stagingPath });
  }
};

export const inspectStorageConsistency = async (runtime: ServerRuntime) => {
  const diskEntries = await fs.promises.readdir(runtime.filesDir, {
    withFileTypes: true,
  });
  const diskFileNames = new Set(
    diskEntries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );
  const rows = runtime.db
    .query("SELECT id, storage_path FROM files")
    .all() as Array<{ id: string; storage_path: string | null }>;
  const missingFiles: string[] = [];
  const knownFileIds = new Set<string>();
  for (const row of rows) {
    knownFileIds.add(row.id);
    if (row.storage_path && !diskFileNames.has(row.id)) {
      missingFiles.push(row.id);
    }
  }
  const untrackedFiles: string[] = [];
  for (const entry of diskEntries) {
    if (
      entry.isFile() &&
      FILE_ID_PATTERN.test(entry.name) &&
      !knownFileIds.has(entry.name)
    ) {
      untrackedFiles.push(entry.name);
    }
  }
  const orphanedReferences = (
    runtime.db
      .query(
        `SELECT COUNT(*) AS count FROM scene_files
         LEFT JOIN files ON files.id = scene_files.file_id
         WHERE files.id IS NULL`,
      )
      .get() as { count: number }
  ).count;
  return { missingFiles, untrackedFiles, orphanedReferences };
};
