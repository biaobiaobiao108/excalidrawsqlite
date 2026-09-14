import fs from "node:fs";
import path from "node:path";

import {
  FILE_ID_PATTERN,
  ORPHAN_FILE_GRACE_MS,
  STALE_FILE_ARTIFACT_MS,
} from "./config";
import { randomHex, sha256Hex } from "./crypto";
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
      .query("SELECT created_at FROM files WHERE id = ?")
      .get(id) as { created_at: number } | null;

    const atomicWrite = prepared.tempPath
      ? await finalizeAtomicFileWrite(filePath, prepared.tempPath)
      : await writeFileAtomically(filePath, prepared.data!);
    try {
      const hasLegacyDataUrl = (
        runtime.db.query("PRAGMA table_info(files)").all() as Array<{
          name: string;
        }>
      ).some((column) => column.name === "data_url");
      const columns = hasLegacyDataUrl
        ? "id, storage_path, data_url, mime_type, byte_size, sha256, created_at, updated_at"
        : "id, storage_path, mime_type, byte_size, sha256, created_at, updated_at";
      const values = hasLegacyDataUrl
        ? "?, ?, '', ?, ?, ?, ?, ?"
        : "?, ?, ?, ?, ?, ?, ?";
      runtime.db.run(
        `INSERT INTO files (${columns})
         VALUES (${values})
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
      createdAt: previous?.created_at || createdAt || now,
      updatedAt: now,
    };
  });
};

export const upsertFile = async (
  runtime: ServerRuntime,
  id: string,
  mimeType: string,
  data: Uint8Array,
  createdAt?: number,
  updatedAt?: number,
) => {
  return upsertPreparedFile(
    runtime,
    id,
    mimeType,
    {
      data,
      byteLength: data.byteLength,
      sha256: sha256Hex(data),
    },
    createdAt,
    updatedAt,
  );
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

export const decodeDataUrl = (value: unknown, expectedMimeType: string) => {
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_FILE_DATA", "文件数据格式无效");
  }
  const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=_-]+)$/);
  if (!match || match[1].toLowerCase() !== expectedMimeType.toLowerCase()) {
    throw new HttpError(
      400,
      "INVALID_FILE_DATA",
      "文件必须是有效的 Base64 data URL",
    );
  }
  const data = Uint8Array.fromBase64(match[2], {
    alphabet: "base64url",
  });
  if (!data.byteLength) {
    throw new HttpError(400, "INVALID_FILE_DATA", "文件内容不能为空");
  }
  return new Uint8Array(data);
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
  for (const fileId of fileIds) {
    const row = runtime.db
      .query("SELECT storage_path FROM files WHERE id = ?")
      .get(fileId) as { storage_path: string | null } | null;
    if (
      !row?.storage_path ||
      !(await fileExists(getFilePath(runtime, fileId)))
    ) {
      throw new HttpError(422, "MISSING_FILE", "画板引用的图片尚未上传完成");
    }
  }
};

export const syncSceneFileReferences = (
  runtime: ServerRuntime,
  sceneId: string,
  fileIds: string[],
) => {
  runtime.db.run("DELETE FROM scene_files WHERE scene_id = ?", [sceneId]);
  for (const fileId of fileIds) {
    runtime.db.run(
      "INSERT INTO scene_files (scene_id, file_id) VALUES (?, ?)",
      [sceneId, fileId],
    );
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
           AND NOT EXISTS (SELECT 1 FROM scenes WHERE scenes.thumbnail_file_id = files.id)`,
      )
      .all(cutoff) as Array<{
      id: string;
      storage_path: string | null;
      updated_at: number;
    }>;

    for (const row of rows) {
      const deleted = runtime.db.run(
        `DELETE FROM files
         WHERE id = ?
           AND updated_at = ?
           AND NOT EXISTS (SELECT 1 FROM scene_files WHERE scene_files.file_id = files.id)
           AND NOT EXISTS (SELECT 1 FROM scenes WHERE scenes.thumbnail_file_id = files.id)`,
        [row.id, row.updated_at],
      );
      if (deleted.changes && row.storage_path) {
        await fs.promises.rm(getFilePath(runtime, row.id), { force: true });
      }
    }
  });
};

export const cleanupStaleFileArtifacts = async (runtime: ServerRuntime) => {
  const cutoff = Date.now() - STALE_FILE_ARTIFACT_MS;
  const entries = await fs.promises.readdir(runtime.filesDir, {
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:tmp|bak)$/.test(entry.name)) {
      continue;
    }
    const filePath = path.join(runtime.filesDir, entry.name);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) {
      await fs.promises.rm(filePath, { force: true });
      console.info("[Files] 清理过期临时附件", { filePath });
    }
  }
};

export const inspectStorageConsistency = async (runtime: ServerRuntime) => {
  const rows = runtime.db
    .query("SELECT id, storage_path FROM files")
    .all() as Array<{ id: string; storage_path: string | null }>;
  const missingFiles: string[] = [];
  const knownFileIds = new Set<string>();
  for (const row of rows) {
    knownFileIds.add(row.id);
    if (row.storage_path && !(await fileExists(getFilePath(runtime, row.id)))) {
      missingFiles.push(row.id);
    }
  }
  const untrackedFiles: string[] = [];
  for (const entry of await fs.promises.readdir(runtime.filesDir, {
    withFileTypes: true,
  })) {
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
