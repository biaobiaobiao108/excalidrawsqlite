import fs from "node:fs";
import path from "node:path";

import {
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
const storageMutationLocks = new WeakMap<ServerRuntime, Promise<void>>();

export const withStorageMutationLock = async <T>(
  runtime: ServerRuntime,
  task: () => Promise<T>,
): Promise<T> => {
  const previous = storageMutationLocks.get(runtime) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  storageMutationLocks.set(runtime, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (storageMutationLocks.get(runtime) === current) {
      storageMutationLocks.delete(runtime);
    }
  }
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
    await fs.promises.rm(backupPath, { force: true });
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
) => {
  return withStorageMutationLock(runtime, async () => {
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
      return {
        id,
        mimeType,
        byteSize: previous.byte_size,
        sha256: previous.sha256,
        createdAt: previous.created_at,
        updatedAt: previous.updated_at,
      };
    }

    const atomicWrite = prepared.tempPath
      ? await finalizeAtomicFileWrite(filePath, prepared.tempPath)
      : await writeFileAtomically(filePath, prepared.data!);
    try {
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
        console.error("[Files] Failed to roll back file after database error", {
          filePath,
          error: restoreError,
        });
        throw new Error("文件写入回滚失败", { cause: restoreError });
      }
      throw error;
    }

    await atomicWrite.cleanup().catch((error) => {
      console.error("[Files] Failed to remove temporary backup", {
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
  const reservedBytes = await runtime.bodyMemoryBudget.acquire(
    runtime.config.maxFileBytes,
    req.signal,
  );
  const writer = Bun.file(tempPath).writer({ highWaterMark: 64 * 1024 });
  const reader = req.body.getReader();
  const hash = new Bun.CryptoHasher("sha256");
  let byteLength = 0;

  try {
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
    await Promise.resolve(writer.end()).catch(() => {});
    await fs.promises.rm(tempPath, { force: true });
    throw error;
  } finally {
    reader.releaseLock();
    runtime.bodyMemoryBudget.release(reservedBytes);
  }
};

export const upsertStagedFile = async (
  runtime: ServerRuntime,
  id: string,
  mimeType: string,
  prepared: PreparedFile,
  createdAt?: number,
  updatedAt?: number,
) => {
  try {
    return await upsertPreparedFile(
      runtime,
      id,
      mimeType,
      prepared,
      createdAt,
      updatedAt,
    );
  } finally {
    if (prepared.tempPath) {
      await fs.promises.rm(prepared.tempPath, { force: true });
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
        console.warn("[Files] 附件垃圾回收失败，保留原文件", {
          id: row.id,
          error,
        });
      }
    }
  });
};

export const cleanupUntrackedFiles = async (runtime: ServerRuntime) => {
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
};

export const cleanupStaleFileArtifacts = async (runtime: ServerRuntime) => {
  const cutoff = Date.now() - STALE_FILE_ARTIFACT_MS;
  const directories = [
    {
      directory: runtime.filesDir,
      pattern: /\.(?:tmp|bak|gc)$/,
    },
    {
      directory: path.dirname(runtime.dbPath),
      pattern: /^excalidraw-(?:backup-.*\.db|full-backup-.*\.tar)\.[A-Za-z0-9]+\.tmp$/,
    },
  ];
  for (const { directory, pattern } of directories) {
    const entries = await fs.promises.readdir(directory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || !pattern.test(entry.name)) {
        continue;
      }
      const filePath = path.join(directory, entry.name);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) {
        await fs.promises.rm(filePath, { force: true });
        console.info("[Files] 清理过期临时附件", { filePath });
      }
    }
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
