import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

import {
  fileExists,
  getFilePath,
  withStorageMutationLock,
} from "./files";
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
  let recordLength = body.length + 2;
  while (String(recordLength).length + body.length + 1 !== recordLength) {
    recordLength = String(recordLength).length + body.length + 1;
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

export const createDatabaseSnapshot = async (
  runtime: ServerRuntime,
  timestamp: string,
) => {
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
) =>
  withStorageMutationLock(runtime, async () => {
    const snapshot = await createDatabaseSnapshot(runtime, timestamp);
    let snapshotDb: Database | undefined;
    try {
      snapshotDb = new Database(snapshot.tempBackupFile, {
        readonly: true,
      });
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
      for (const row of filesQuery.iterate() as Iterable<BackupFileRow>) {
        if (!row.storage_path) {
          continue;
        }
        const filePath = getFilePath(runtime, row.id);
        if (!(await fileExists(filePath))) {
          throw new Error(`附件文件缺失：${row.id}`);
        }
        archiveBytes += tarEntrySize(`files/${row.id}`, Bun.file(filePath).size);
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

        for (const row of filesQuery.iterate() as Iterable<BackupFileRow>) {
          if (!row.storage_path) {
            continue;
          }
          const filePath = getFilePath(runtime, row.id);
          if (!(await fileExists(filePath))) {
            throw new Error(`附件文件缺失：${row.id}`);
          }
          const file = Bun.file(filePath);
          archiveBytes += tarEntrySize(`files/${row.id}`, file.size);
          ensureBackupWithinLimit(archiveBytes, runtime.config.maxBackupBytes);
          await writeTarFile(writer, `files/${row.id}`, filePath, file.size);
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
      await snapshot.cleanup().catch(() => {});
    }
  });
