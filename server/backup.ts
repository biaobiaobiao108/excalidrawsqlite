import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

import {
  fileExists,
  getFilePath,
  withStorageMutationLock,
} from "./files";
import { BACKUP_STAGING_DIR_PREFIX } from "./config";
import { randomHex } from "./crypto";
import { HttpError } from "./errors";

import type { ServerRuntime } from "./types";

const activeBackups = new WeakSet<ServerRuntime>();
const TAR_BLOCK_SIZE = 512;
const textEncoder = new TextEncoder();

const writeAscii = (
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
) => {
  const bytes = textEncoder.encode(value);
  target.set(bytes.subarray(0, length), offset);
};

const writeOctal = (
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
) => {
  const encoded = Math.max(0, Math.floor(value)).toString(8);
  writeAscii(target, offset, length, encoded.padStart(length - 1, "0"));
  target[offset + length - 1] = 0;
};

const createTarHeader = (
  name: string,
  size: number,
  type: "file" | "pax",
) => {
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  writeAscii(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  header[156] = type === "pax" ? 0x78 : 0x30;
  writeAscii(header, 257, 6, "ustar\0");
  writeAscii(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeAscii(header, 148, 6, checksum.toString(8).padStart(6, "0"));
  header[154] = 0;
  header[155] = 0x20;
  return header;
};

const createPaxPath = (pathValue: string) => {
  const body = `path=${pathValue}\n`;
  const bodyByteLength = textEncoder.encode(body).byteLength;
  let recordLength = bodyByteLength + 2;
  while (String(recordLength).length + bodyByteLength + 1 !== recordLength) {
    recordLength = String(recordLength).length + bodyByteLength + 1;
  }
  return textEncoder.encode(`${recordLength} ${body}`);
};

const paddedTarSize = (size: number) =>
  Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

const tarEntrySize = (name: string, size: number) => {
  const paxSize = name.length > 100 ? createPaxPath(name).byteLength : 0;
  return (
    TAR_BLOCK_SIZE +
    (paxSize ? TAR_BLOCK_SIZE + paddedTarSize(paxSize) : 0) +
    paddedTarSize(size)
  );
};

type BackupFileRow = {
  id: string;
  storage_path: string | null;
  mime_type: string;
  byte_size: number;
  sha256: string;
  created_at: number;
  updated_at: number;
};

const BACKUP_FILES_QUERY = `SELECT id, storage_path, mime_type, byte_size, sha256,
  created_at, updated_at FROM files ORDER BY id`;

const serializeManifestFile = (row: BackupFileRow) => {
  const { id, storage_path, ...metadata } = row;
  return JSON.stringify({
    id,
    path: storage_path ? `files/${id}` : null,
    ...metadata,
  });
};

const manifestPrefix = (createdAt: string) =>
  `{"format":"excalidraw-full-backup","version":1,"createdAt":${JSON.stringify(createdAt)},"database":"excalidraw.db","filesDirectory":"files","files":[`;

const manifestSuffix = "]}";

const writeTarManifest = async (
  writer: ReturnType<ReturnType<typeof Bun.file>["writer"]>,
  query: ReturnType<Database["query"]>,
  prefix: string,
  expectedSize: number,
) => {
  await writer.write(createTarHeader("manifest.json", expectedSize, "file"));
  let written = 0;
  const writeText = async (value: string) => {
    const bytes = textEncoder.encode(value);
    written += bytes.byteLength;
    if (written > expectedSize) {
      throw new Error("备份清单大小在写入期间发生变化");
    }
    await writer.write(bytes);
  };
  await writeText(prefix);
  let first = true;
  for (const row of query.iterate() as Iterable<BackupFileRow>) {
    await writeText(`${first ? "" : ","}${serializeManifestFile(row)}`);
    first = false;
  }
  await writeText(manifestSuffix);
  if (written !== expectedSize) {
    throw new Error("备份清单大小在写入期间发生变化");
  }
  await writePadding(writer, written);
};

const ensureBackupWithinLimit = (size: number, maxBytes: number) => {
  if (!Number.isSafeInteger(size) || size > maxBytes) {
    throw new HttpError(413, "BACKUP_TOO_LARGE", "备份内容超过大小限制");
  }
};

const writePadding = async (
  writer: ReturnType<ReturnType<typeof Bun.file>["writer"]>,
  size: number,
) => {
  const padding = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
  if (padding) {
    await writer.write(new Uint8Array(padding));
  }
};

const writeTarFile = async (
  writer: ReturnType<ReturnType<typeof Bun.file>["writer"]>,
  name: string,
  filePath: string,
  size: number,
) => {
  if (name.length > 100) {
    const paxPath = createPaxPath(name);
    await writer.write(
      createTarHeader("PaxHeader", paxPath.byteLength, "pax"),
    );
    await writer.write(paxPath);
    await writePadding(writer, paxPath.byteLength);
  }

  await writer.write(
    createTarHeader(name.length > 100 ? name.slice(-100) : name, size, "file"),
  );
  const reader = Bun.file(filePath).stream().getReader();
  let written = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      written += result.value.byteLength;
      if (written > size) {
        await reader.cancel();
        throw new Error(`备份文件大小在读取期间发生变化：${name}`);
      }
      await writer.write(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (written !== size) {
    throw new Error(`备份文件大小在读取期间发生变化：${name}`);
  }
  await writePadding(writer, size);
};

export const acquireBackupLock = (runtime: ServerRuntime) => {
  if (activeBackups.has(runtime)) {
    throw new HttpError(429, "BACKUP_BUSY", "已有备份任务正在进行，请稍后重试");
  }
  activeBackups.add(runtime);
  let released = false;
  return () => {
    if (!released) {
      released = true;
      activeBackups.delete(runtime);
    }
  };
};

export const withBackupLock = async <T>(
  runtime: ServerRuntime,
  task: () => Promise<T>,
) => {
  const release = acquireBackupLock(runtime);
  try {
    return await task();
  } finally {
    release();
  }
};

const registerBackupArtifact = (runtime: ServerRuntime, filePath: string) => {
  const resolved = path.resolve(filePath);
  runtime.activeBackupArtifacts.add(resolved);
  return () => runtime.activeBackupArtifacts.delete(resolved);
};

/**
 * Freeze the attachments referenced by the database snapshot before the
 * archive is written.
 *
 * Hard links make the bytes immutable from the archive writer's point of view:
 * uploading a replacement attachment renames a new inode over the original
 * path, and garbage collection only unlinks it, so the link keeps pointing at
 * the version the snapshot describes. Linking is O(number of files) instead of
 * O(bytes), which lets `createFullBackup` release the storage mutation lock
 * before streaming the archive.
 */
const stageAttachments = async (
  runtime: ServerRuntime,
  stageDir: string,
  filesQuery: ReturnType<Database["query"]>,
) => {
  await fs.promises.mkdir(stageDir, { recursive: true });
  const staged = new Map<string, number>();
  for (const row of filesQuery.iterate() as Iterable<BackupFileRow>) {
    if (!row.storage_path) {
      continue;
    }
    const source = getFilePath(runtime, row.id);
    if (!(await fileExists(source))) {
      throw new Error(`附件文件缺失：${row.id}`);
    }
    const target = path.join(stageDir, row.id);
    try {
      await fs.promises.link(source, target);
    } catch (error: any) {
      if (error?.code !== "EEXIST") {
        // Filesystems without hard link support still get a consistent copy;
        // correctness is preserved, only the lock is held for longer.
        await fs.promises.copyFile(source, target);
      }
    }
    staged.set(row.id, Bun.file(target).size);
  }
  return staged;
};

const removeBackupArtifact = async (
  runtime: ServerRuntime,
  filePath: string,
) => {
  const resolved = path.resolve(filePath);
  try {
    await fs.promises.rm(resolved, { force: true });
  } finally {
    runtime.activeBackupArtifacts.delete(resolved);
  }
};

const assertDatabaseSnapshotCanFit = (
  runtime: ServerRuntime,
  maxBytes: number,
) => {
  const pageSize = Number(
    (runtime.db.query("PRAGMA page_size").get() as { page_size: number })
      .page_size,
  );
  if (maxBytes < pageSize) {
    throw new HttpError(413, "BACKUP_TOO_LARGE", "备份内容超过大小限制");
  }

  // Text payload bytes are a strict lower bound on a SQLite snapshot: these
  // values must be stored in the database in addition to its pages, headers,
  // integer columns and indexes. Rejecting from this bound avoids writing a
  // huge VACUUM INTO artifact while still allowing VACUUM to reclaim free pages.
  const minimumContentBytes = Number(
    (
      runtime.db
        .query(
          `SELECT COALESCE(SUM(bytes), 0) AS bytes FROM (
             SELECT length(CAST(id AS BLOB)) + length(CAST(name AS BLOB)) +
                    length(CAST(elements AS BLOB)) + length(CAST(app_state AS BLOB)) +
                    length(CAST(tags_json AS BLOB)) + length(CAST(content_sha256 AS BLOB)) AS bytes
             FROM scenes
             UNION ALL
             SELECT length(CAST(id AS BLOB)) + length(CAST(name AS BLOB)) +
                    length(CAST(icon AS BLOB)) + length(CAST(color AS BLOB)) AS bytes
             FROM folders
             UNION ALL
             SELECT length(CAST(id AS BLOB)) + COALESCE(length(CAST(storage_path AS BLOB)), 0) +
                    length(CAST(mime_type AS BLOB)) + length(CAST(sha256 AS BLOB)) AS bytes
             FROM files
             UNION ALL
             SELECT length(CAST(scene_id AS BLOB)) + length(CAST(file_id AS BLOB)) AS bytes
             FROM scene_files
             UNION ALL
             SELECT length(CAST(token AS BLOB)) AS bytes FROM sessions
             UNION ALL
             SELECT length(CAST(key_sha256 AS BLOB)) + length(CAST(payload_sha256 AS BLOB)) +
                    length(CAST(scene_id AS BLOB)) AS bytes
             FROM scene_create_requests
           )`,
        )
        .get() as { bytes: number }
    ).bytes,
  );
  if (minimumContentBytes > maxBytes) {
    throw new HttpError(413, "BACKUP_TOO_LARGE", "备份内容超过大小限制");
  }
};

export const createDatabaseSnapshot = async (
  runtime: ServerRuntime,
  timestamp: string,
) => {
  assertDatabaseSnapshotCanFit(runtime, runtime.config.maxBackupBytes);
  const tempBackupFile = path.join(
    path.dirname(runtime.dbPath),
    `excalidraw-backup-${timestamp}-${randomHex(4)}.db`,
  );
  const tempBackupPath = `${tempBackupFile}.${randomHex(8)}.tmp`;
  const unregisterTemp = registerBackupArtifact(runtime, tempBackupPath);
  const unregisterFinal = registerBackupArtifact(runtime, tempBackupFile);
  try {
    const escapedPath = tempBackupPath.replace(/'/g, "''");
    runtime.db.run(`VACUUM INTO '${escapedPath}'`);
    if (Bun.file(tempBackupPath).size > runtime.config.maxBackupBytes) {
      throw new HttpError(413, "BACKUP_TOO_LARGE", "备份内容超过大小限制");
    }
    await fs.promises.rename(tempBackupPath, tempBackupFile);
    unregisterTemp();
    return {
      tempBackupFile,
      cleanup: () => removeBackupArtifact(runtime, tempBackupFile),
    };
  } catch (error) {
    await fs.promises.rm(tempBackupPath, { force: true }).catch(() => {});
    await fs.promises.rm(tempBackupFile, { force: true }).catch(() => {});
    unregisterTemp();
    unregisterFinal();
    throw error;
  }
};

export const createFullBackup = async (
  runtime: ServerRuntime,
  timestamp: string,
) => {
  const stagingDir = path.join(
    path.dirname(runtime.dbPath),
    `${BACKUP_STAGING_DIR_PREFIX}${timestamp}-${randomHex(4)}`,
  );
  const unregisterStagingDir = registerBackupArtifact(runtime, stagingDir);
  let snapshot:
    | Awaited<ReturnType<typeof createDatabaseSnapshot>>
    | undefined;
  let snapshotDb: Database | undefined;
  try {
    let stagedFiles = new Map<string, number>();
    // Phase 1 (locked): snapshot the database and freeze the attachments it
    // references. Both steps cost O(files), not O(bytes), so uploads and scene
    // writes wait for the snapshot only, never for the whole archive.
    await withStorageMutationLock(runtime, async () => {
      snapshot = await createDatabaseSnapshot(runtime, timestamp);
      snapshotDb = new Database(snapshot.tempBackupFile, {
        readonly: true,
      });
      stagedFiles = await stageAttachments(
        runtime,
        stagingDir,
        snapshotDb.query(BACKUP_FILES_QUERY),
      );
    });
    if (!snapshot || !snapshotDb) {
      throw new Error("备份快照未准备完成");
    }

    // Phase 2 (unlocked): stream the archive from the staged attachments.
    const filesQuery = snapshotDb.query(BACKUP_FILES_QUERY);
    const createdAt = new Date().toISOString();
    const prefix = manifestPrefix(createdAt);
    const databaseFile = Bun.file(snapshot.tempBackupFile);
    const baseArchiveBytes =
      TAR_BLOCK_SIZE * 2 +
      tarEntrySize("excalidraw.db", databaseFile.size);
    let manifestBytes =
      textEncoder.encode(prefix).byteLength +
      textEncoder.encode(manifestSuffix).byteLength;
    let rowCount = 0;

    // Count and validate rows one at a time. The manifest remains bounded by
    // MAX_BACKUP_BYTES without materializing either the row set or JSON text.
    for (const row of filesQuery.iterate() as Iterable<BackupFileRow>) {
      const serializedBytes = textEncoder.encode(
        serializeManifestFile(row),
      ).byteLength;
      manifestBytes += serializedBytes + (rowCount > 0 ? 1 : 0);
      rowCount += 1;
      ensureBackupWithinLimit(
        baseArchiveBytes + tarEntrySize("manifest.json", manifestBytes),
        runtime.config.maxBackupBytes,
      );
    }

    let archiveBytes =
      baseArchiveBytes + tarEntrySize("manifest.json", manifestBytes);
    ensureBackupWithinLimit(archiveBytes, runtime.config.maxBackupBytes);
    for (const [id, stagedSize] of stagedFiles) {
      archiveBytes += tarEntrySize(`files/${id}`, stagedSize);
      ensureBackupWithinLimit(archiveBytes, runtime.config.maxBackupBytes);
    }

    const manifestSize = manifestBytes;

    const archivePath = path.join(
      path.dirname(runtime.dbPath),
      `excalidraw-full-backup-${timestamp}-${randomHex(4)}.tar`,
    );
    const tempArchivePath = `${archivePath}.${randomHex(8)}.tmp`;
    const unregisterTemp = registerBackupArtifact(runtime, tempArchivePath);
    const unregisterFinal = registerBackupArtifact(runtime, archivePath);
    let archiveWriter:
      | ReturnType<ReturnType<typeof Bun.file>["writer"]>
      | undefined;
    try {
      const writer = Bun.file(tempArchivePath).writer({
        highWaterMark: 64 * 1024,
      });
      archiveWriter = writer;
      await writeTarFile(
        writer,
        "excalidraw.db",
        snapshot.tempBackupFile,
        databaseFile.size,
      );
      await writeTarManifest(writer, filesQuery, prefix, manifestSize);

      for (const [id, stagedSize] of stagedFiles) {
        await writeTarFile(
          writer,
          `files/${id}`,
          path.join(stagingDir, id),
          stagedSize,
        );
      }
      await writer.write(new Uint8Array(TAR_BLOCK_SIZE * 2));
      await writer.end();
      await fs.promises.rename(tempArchivePath, archivePath);
      unregisterTemp();
    } catch (error) {
      await Promise.resolve(archiveWriter?.end()).catch(() => {});
      await fs.promises.rm(tempArchivePath, { force: true }).catch(() => {});
      await fs.promises.rm(archivePath, { force: true }).catch(() => {});
      unregisterTemp();
      unregisterFinal();
      throw error;
    }

    const archiveFile = Bun.file(archivePath);
    return {
      archivePath,
      size: archiveFile.size,
      cleanup: () => removeBackupArtifact(runtime, archivePath),
    };
  } finally {
    snapshotDb?.close();
    await snapshot?.cleanup().catch(() => {});
    await fs.promises
      .rm(stagingDir, { recursive: true, force: true })
      .catch(() => {});
    unregisterStagingDir();
  }
};
