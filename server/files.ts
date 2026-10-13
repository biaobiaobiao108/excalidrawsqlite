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

let fileSystemModule: Promise<typeof import("node:fs")> | undefined;
const getFileSystem = () => (fileSystemModule ??= import("node:fs"));

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

const requireFilesDir = (runtime: ServerRuntime) => {
  if (!runtime.filesDir) throw new Error("Filesystem attachment storage is unavailable");
  return runtime.filesDir;
};

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
  const base = path.resolve(requireFilesDir(runtime));
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
  const fs = await getFileSystem();
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
  const fs = await getFileSystem();
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
  objectKey?: string;
};

export type StoredFileMetadata = {
  id: string;
  storage_path: string | null;
  mime_type: string;
  byte_size: number;
  sha256: string;
  created_at: number;
  updated_at: number;
};

export const getStoredFileMetadata = async (
  runtime: ServerRuntime,
  id: string,
): Promise<StoredFileMetadata | null> =>
  runtime.db
    .query(
      "SELECT id, storage_path, mime_type, byte_size, sha256, created_at, updated_at FROM files WHERE id = ? LIMIT 1",
    )
    .get<StoredFileMetadata>(id);

export const getFileObject = async (runtime: ServerRuntime, id: string) => {
  const metadata = await getStoredFileMetadata(runtime, id);
  if (!metadata?.storage_path) return null;
  if (runtime.files) {
    return runtime.files.get(metadata.storage_path).then((object) =>
      object
        ? {
            body: object.body,
            size: object.size,
            etag: metadata.sha256,
            httpEtag: metadata.sha256,
            httpMetadata: {
              ...object.httpMetadata,
              contentType: object.httpMetadata?.contentType || metadata.mime_type,
            },
            metadata,
          }
        : null,
    );
  }
  const filePath = getFilePath(runtime, id);
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  return {
    body: file.stream(),
    size: file.size,
    etag: metadata.sha256,
    httpEtag: metadata.sha256,
    httpMetadata: { contentType: metadata.mime_type },
    metadata,
  };
};

const sha256Constants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// Web Crypto exposes one-shot digest only. This small SHA-256 accumulator keeps
// uploads streamed to R2 without retaining a second full copy in Worker memory.
class StreamingSha256 {
  private state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private pending = new Uint8Array(64);
  private pendingBytes = 0;
  private bytes = 0;

  update(chunk: Uint8Array) {
    this.bytes += chunk.byteLength;
    let offset = 0;
    if (this.pendingBytes) {
      const count = Math.min(64 - this.pendingBytes, chunk.byteLength);
      this.pending.set(chunk.subarray(0, count), this.pendingBytes);
      this.pendingBytes += count;
      offset += count;
      if (this.pendingBytes === 64) {
        this.compress(this.pending);
        this.pendingBytes = 0;
      }
    }
    while (offset + 64 <= chunk.byteLength) {
      this.compress(chunk.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < chunk.byteLength) {
      this.pending.set(chunk.subarray(offset), 0);
      this.pendingBytes = chunk.byteLength - offset;
    }
  }

  digestHex() {
    const bitLength = this.bytes * 8;
    const tailLength = this.pendingBytes < 56 ? 64 : 128;
    const tail = new Uint8Array(tailLength);
    tail.set(this.pending.subarray(0, this.pendingBytes));
    tail[this.pendingBytes] = 0x80;
    const view = new DataView(tail.buffer);
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    view.setUint32(tailLength - 8, high, false);
    view.setUint32(tailLength - 4, low, false);
    for (let offset = 0; offset < tailLength; offset += 64) {
      this.compress(tail.subarray(offset, offset + 64));
    }
    return Array.from(this.state, (word) => word.toString(16).padStart(8, "0")).join("");
  }

  private compress(block: Uint8Array) {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15];
      const y = words[index - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choice = (e & f) ^ (~e & g);
      const first = (h + s1 + choice + sha256Constants[index] + words[index]) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0;
      d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

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
    if (!prepared.data && !prepared.tempPath && !prepared.objectKey) {
      throw new Error("文件内容未准备完成");
    }

    const now = Number.isFinite(updatedAt) ? Number(updatedAt) : Date.now();
    const previous = await runtime.db
      .query(
        "SELECT created_at, updated_at, byte_size, sha256, mime_type, storage_path FROM files WHERE id = ?",
      )
      .get<{
      created_at: number;
      updated_at: number;
      byte_size: number;
      sha256: string;
      mime_type: string;
      storage_path: string | null;
    }>(id);

    if (
      previous &&
      previous.byte_size === prepared.byteLength &&
      previous.sha256 === prepared.sha256 &&
      previous.mime_type.toLowerCase() === mimeType.toLowerCase() &&
      (runtime.files
        ? Boolean(previous.storage_path && await runtime.files.head(previous.storage_path))
        : await fileExists(getFilePath(runtime, id)))
    ) {
      // An identical upload still renews the orphan grace period; explicit
      // thumbnail versions retain their monotonic ordering instead.
      const nextUpdatedAt = Math.max(previous.updated_at, now);
      if (nextUpdatedAt !== previous.updated_at) {
        await runtime.db.run("UPDATE files SET updated_at = ? WHERE id = ?", [
          nextUpdatedAt,
          id,
        ]);
      }
      if (runtime.files && prepared.objectKey) {
        await runtime.files.delete(prepared.objectKey);
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

    if (runtime.files) {
      if (!prepared.objectKey) throw new Error("R2 附件对象未准备完成");
      try {
        await runtime.db.run(
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
            prepared.objectKey,
            mimeType,
            prepared.byteLength,
            prepared.sha256,
            previous?.created_at || createdAt || now,
            now,
          ],
        );
      } catch (error) {
        await runtime.files.delete(prepared.objectKey).catch((rollbackError) => {
          console.info("[Files] Failed to remove uncommitted R2 object", {
            key: prepared.objectKey,
            error: rollbackError,
          });
        });
        throw error;
      }
      return {
        id,
        mimeType,
        byteSize: prepared.byteLength,
        sha256: prepared.sha256,
        createdAt: previous?.created_at || createdAt || now,
        updatedAt: now,
      };
    }

    const filePath = getFilePath(runtime, id);
    const atomicWrite = prepared.tempPath
      ? await finalizeAtomicFileWrite(filePath, prepared.tempPath)
      : await writeFileAtomically(filePath, prepared.data!);
    try {
      await runtime.db.run(
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

  if (runtime.files) {
    const reservedBytes = await runtime.bodyMemoryBudget.acquire(
      runtime.config.maxFileBytes,
      req.signal,
    );
    const objectKey = `files/${validateId(id, "file")}/${randomHex(16)}`;
    const hash = new StreamingSha256();
    let byteLength = 0;
    const hashReader = req.clone().body!.getReader();
    const putPromise = runtime.files.put(objectKey, req.body);
    let tooLarge = false;
    try {
      while (true) {
        const result = await hashReader.read();
        if (result.done) break;
        byteLength += result.value.byteLength;
        if (byteLength > runtime.config.maxFileBytes) {
          tooLarge = true;
          continue;
        }
        hash.update(result.value);
      }
      await putPromise;
      if (tooLarge) throw getFileTooLargeError(runtime.config.maxFileBytes);
      if (!byteLength) throw new HttpError(400, "EMPTY_FILE", "文件内容不能为空");
      return { objectKey, byteLength, sha256: hash.digestHex() };
    } catch (error) {
      await hashReader.cancel(error).catch(() => {});
      await putPromise.catch(() => {});
      await runtime.files.delete(objectKey).catch(() => {});
      throw error;
    } finally {
      hashReader.releaseLock();
      runtime.bodyMemoryBudget.release(reservedBytes);
    }
  }

  const fs = await getFileSystem();
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
  } catch (error) {
    if (runtime.files && prepared.objectKey) {
      await runtime.files.delete(prepared.objectKey).catch(() => {});
    }
    throw error;
  } finally {
    if (prepared.tempPath) {
      const fs = await getFileSystem();
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
    const rows = await runtime.db
      .query(
        `SELECT id, storage_path FROM files WHERE id IN (${placeholders})`,
      )
      .all<{ id: string; storage_path: string | null }>(...chunk);
    for (const row of rows) {
      rowsById.set(row.id, row);
    }
  }

  for (const fileId of fileIds) {
    const row = rowsById.get(fileId);
    const exists = row?.storage_path && (runtime.files
      ? Boolean(await runtime.files.head(row.storage_path))
      : await fileExists(getFilePath(runtime, fileId)));
    if (!exists) {
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

export const syncSceneFileReferences = async (
  runtime: ServerRuntime,
  sceneId: string,
  fileIds: string[],
): Promise<void> => {
  await runtime.db.batch(await getSceneFileReferenceMutationStatements(runtime, sceneId, fileIds));
};

export const getSceneFileReferenceMutationStatements = async (
  runtime: ServerRuntime,
  sceneId: string,
  fileIds: string[],
  guardRevision?: number,
) => {
  const statements = getSceneFileReferenceStatements(runtime);
  const existingFileIds = new Set(
    (await statements.list.all<{ file_id: string }>(sceneId)).map(
      (row) => row.file_id,
    ),
  );
  const nextFileIds = new Set(fileIds);
  const batch: Array<{ sql: string; values: readonly (string | number | null | Uint8Array)[] }> = [];
  for (const fileId of existingFileIds) {
    if (!nextFileIds.has(fileId)) {
      batch.push({
        sql: guardRevision === undefined
          ? "DELETE FROM scene_files WHERE scene_id = ? AND file_id = ?"
          : "DELETE FROM scene_files WHERE scene_id = ? AND file_id = ? AND EXISTS (SELECT 1 FROM scenes WHERE id = ? AND revision = ? AND deleted_at IS NULL)",
        values: guardRevision === undefined
          ? [sceneId, fileId]
          : [sceneId, fileId, sceneId, guardRevision],
      });
    }
  }
  for (const fileId of nextFileIds) {
    if (!existingFileIds.has(fileId)) {
      batch.push({
        sql: guardRevision === undefined
          ? "INSERT OR IGNORE INTO scene_files (scene_id, file_id) VALUES (?, ?)"
          : "INSERT OR IGNORE INTO scene_files (scene_id, file_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM scenes WHERE id = ? AND revision = ? AND deleted_at IS NULL)",
        values: guardRevision === undefined
          ? [sceneId, fileId]
          : [sceneId, fileId, sceneId, guardRevision],
      });
    }
  }
  return batch;
};

export const cleanupOrphanedFiles = async (runtime: ServerRuntime) => {
  await withStorageMutationLock(runtime, async () => {
    const cutoff = Date.now() - ORPHAN_FILE_GRACE_MS;
    const rows = await runtime.db
      .query(
        `SELECT id, storage_path, updated_at FROM files
         WHERE updated_at < ?
           AND NOT EXISTS (SELECT 1 FROM scene_files WHERE scene_files.file_id = files.id)
           AND NOT EXISTS (SELECT 1 FROM scenes WHERE scenes.thumbnail_file_id = files.id)
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all<{
      id: string;
      storage_path: string | null;
      updated_at: number;
    }>(cutoff, ORPHAN_FILE_CLEANUP_BATCH_SIZE);

    for (const row of rows) {
      if (runtime.files) {
        try {
          const deleted = await runtime.db.run(
            `DELETE FROM files
             WHERE id = ? AND updated_at = ?
               AND NOT EXISTS (SELECT 1 FROM scene_files WHERE scene_files.file_id = files.id)
               AND NOT EXISTS (SELECT 1 FROM scenes WHERE scenes.thumbnail_file_id = files.id)`,
            [row.id, row.updated_at],
          );
          if (deleted.changes && row.storage_path) {
            await runtime.files.delete(row.storage_path);
          }
        } catch (error) {
          console.info("[Files] 附件垃圾回收失败，保留原文件", {
            id: row.id,
            error,
          });
        }
        continue;
      }
      const fs = await getFileSystem();
      const filePath = getFilePath(runtime, row.id);
      const quarantinePath = `${filePath}.${randomHex(8)}.gc`;
      let quarantined = false;
      try {
        if (row.storage_path && (await fileExists(filePath))) {
          await fs.promises.rename(filePath, quarantinePath);
          quarantined = true;
        }
        const deleted = await runtime.db.run(
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

    if (runtime.files) {
      const rows = await runtime.db
        .query("SELECT storage_path FROM files WHERE storage_path IS NOT NULL")
        .all<{ storage_path: string }>();
      const referencedObjects = new Set(rows.map((row) => row.storage_path));
      const staleObjects: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await runtime.files.list({ prefix: "files/", limit: 100, cursor });
        for (const object of page.objects) {
          if (
            staleObjects.length < ORPHAN_FILE_CLEANUP_BATCH_SIZE &&
            object.uploaded &&
            object.uploaded.getTime() < cutoff &&
            !referencedObjects.has(object.key)
          ) {
            staleObjects.push(object.key);
          }
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor && staleObjects.length < ORPHAN_FILE_CLEANUP_BATCH_SIZE);
      if (staleObjects.length) await runtime.files.delete(staleObjects);
    }
  });
};

export const cleanupUntrackedFiles = async (runtime: ServerRuntime) => {
  if (runtime.files) return;
  const fs = await getFileSystem();
  await withStorageMutationLock(runtime, async () => {
    const filesDir = requireFilesDir(runtime);
    const knownFileIds = new Set(
      (await runtime.db.query("SELECT id FROM files").all<{ id: string }>()).map(
        (row) => row.id,
      ),
    );
    const cutoff = Date.now() - ORPHAN_FILE_GRACE_MS;
    let cleaned = 0;
    for (const entry of await fs.promises.readdir(filesDir, {
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
      const filePath = path.join(filesDir, entry.name);
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
  const fs = await getFileSystem();
  const filesDir = requireFilesDir(runtime);
  const entries = await fs.promises.readdir(filesDir, {
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
          .stat(path.join(filesDir, backup.name))
          .catch(() => null))?.mtimeMs || 0,
    })),
  );
  backupsWithTime.sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const { id, name } of backupsWithTime) {
    const filePath = getFilePath(runtime, id);
    const backupPath = path.join(filesDir, name);
    const metadata = await runtime.db
      .query("SELECT byte_size, sha256 FROM files WHERE id = ?")
      .get<{ byte_size: number; sha256: string }>(id);
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
  if (runtime.files) return;
  const fs = await getFileSystem();
  const filesDir = requireFilesDir(runtime);
  // Serialize recovery with file uploads so cleanup cannot observe the brief
  // Windows replace window between removing the destination and renaming it.
  await withStorageMutationLock(runtime, async () => {
    await recoverInterruptedFileReplacements(runtime);
  });
  const cutoff = Date.now() - STALE_FILE_ARTIFACT_MS;
  const directories = [
    {
      directory: filesDir,
      pattern: /\.(?:tmp|bak|gc)$/,
      staleOnly: true,
    },
    ...(runtime.dbPath ? [{
      directory: path.dirname(runtime.dbPath),
      pattern:
        /^excalidraw-(?:backup-.*\.db|full-backup-.*\.tar)(?:\.[A-Za-z0-9]+\.tmp)?$/,
      // Backup paths are registered before opening/writing and stay registered
      // until their response is complete. Any matching unregistered file came
      // from an interrupted process and can be removed immediately at startup.
      staleOnly: false,
    }] : []),
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
      if (runtime.activeBackupArtifacts.has(path.resolve(filePath))) {
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
            const metadata = await runtime.db
              .query("SELECT byte_size, sha256 FROM files WHERE id = ?")
              .get<{ byte_size: number; sha256: string }>(backupMatch[1]);
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
};

export const inspectStorageConsistency = async (runtime: ServerRuntime) => {
  if (runtime.files) {
    const rows = await runtime.db
      .query("SELECT id, storage_path FROM files")
      .all<{ id: string; storage_path: string | null }>();
    const knownFileIds = new Set(rows.map((row) => row.id));
    const missingFiles: string[] = [];
    const knownObjectKeys = new Set<string>();
    for (const row of rows) {
      if (row.storage_path) {
        knownObjectKeys.add(row.storage_path);
        if (!(await runtime.files.head(row.storage_path))) missingFiles.push(row.id);
      } else {
        missingFiles.push(row.id);
      }
    }
    const untrackedFiles: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await runtime.files.list({ prefix: "files/", limit: 100, cursor });
      for (const object of page.objects) {
        if (!knownObjectKeys.has(object.key)) untrackedFiles.push(object.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const orphanRow = await runtime.db
      .query(
        `SELECT COUNT(*) AS count FROM scene_files
         LEFT JOIN files ON files.id = scene_files.file_id
         WHERE files.id IS NULL`,
      )
      .get<{ count: number }>();
    return { missingFiles, untrackedFiles, orphanedReferences: orphanRow?.count ?? 0 };
  }
  const fs = await getFileSystem();
  const diskEntries = await fs.promises.readdir(requireFilesDir(runtime), {
    withFileTypes: true,
  });
  const diskFileNames = new Set(
    diskEntries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );
  const rows = await runtime.db
    .query("SELECT id, storage_path FROM files")
    .all<{ id: string; storage_path: string | null }>();
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
  const orphanRow = await runtime.db
      .query(
        `SELECT COUNT(*) AS count FROM scene_files
         LEFT JOIN files ON files.id = scene_files.file_id
         WHERE files.id IS NULL`,
      )
      .get<{ count: number }>();
  const orphanedReferences = orphanRow?.count ?? 0;
  return { missingFiles, untrackedFiles, orphanedReferences };
};
