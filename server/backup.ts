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

const writeTarBytes = async (
  writer: ReturnType<ReturnType<typeof Bun.file>["writer"]>,
  name: string,
  bytes: Uint8Array,
) => {
  await writer.write(createTarHeader(name, bytes.byteLength, "file"));
  await writer.write(bytes);
  await writePadding(writer, bytes.byteLength);
};

export const withBackupLock = async <T>(
  runtime: ServerRuntime,
  task: () => Promise<T>,
) => {
  if (activeBackups.has(runtime)) {
    throw new HttpError(429, "BACKUP_BUSY", "已有备份任务正在进行，请稍后重试");
  }
  activeBackups.add(runtime);
  try {
    return await task();
  } finally {
    activeBackups.delete(runtime);
  }
};

export const createDatabaseSnapshot = async (
  runtime: ServerRuntime,
  timestamp: string,
) => {
  const pageCount = Number(
    (runtime.db.query("PRAGMA page_count").get() as { page_count?: number })
      ?.page_count,
  );
  const pageSize = Number(
    (runtime.db.query("PRAGMA page_size").get() as { page_size?: number })
      ?.page_size,
  );
  if (
    Number.isSafeInteger(pageCount) &&
    Number.isSafeInteger(pageSize) &&
    pageCount * pageSize > runtime.config.maxBackupBytes
  ) {
    throw new HttpError(413, "BACKUP_TOO_LARGE", "备份内容超过大小限制");
  }
  const tempBackupFile = path.join(
    path.dirname(runtime.dbPath),
    `excalidraw-backup-${timestamp}-${randomHex(4)}.db`,
  );
  const escapedPath = tempBackupFile.replace(/'/g, "''");
  runtime.db.run(`VACUUM INTO '${escapedPath}'`);
  return {
    tempBackupFile,
    cleanup: () => fs.promises.rm(tempBackupFile, { force: true }),
  };
};

export const createFullBackup = async (
  runtime: ServerRuntime,
  timestamp: string,
) =>
  withStorageMutationLock(runtime, async () => {
    const snapshot = await createDatabaseSnapshot(runtime, timestamp);
    try {
      const snapshotDb = new Database(snapshot.tempBackupFile, {
        readonly: true,
      });
      let fileRows: Array<{
        id: string;
        storage_path: string | null;
        mime_type: string;
        byte_size: number;
        sha256: string;
        created_at: number;
        updated_at: number;
      }>;
      try {
        fileRows = snapshotDb
          .query(
            `SELECT id, storage_path, mime_type, byte_size, sha256, created_at, updated_at
             FROM files ORDER BY id`,
          )
          .all() as typeof fileRows;
      } finally {
        snapshotDb.close();
      }

      const manifest = JSON.stringify(
        {
          format: "excalidraw-full-backup",
          version: 1,
          createdAt: new Date().toISOString(),
          database: "excalidraw.db",
          filesDirectory: "files",
          files: fileRows.map(({ id, storage_path, ...metadata }) => ({
            id,
            path: storage_path ? `files/${id}` : null,
            ...metadata,
          })),
        },
        null,
        2,
      );
      const databaseFile = Bun.file(snapshot.tempBackupFile);
      let totalBytes = databaseFile.size;
      if (totalBytes > runtime.config.maxBackupBytes) {
        throw new HttpError(413, "BACKUP_TOO_LARGE", "备份内容超过大小限制");
      }
      const manifestBytes = new TextEncoder().encode(manifest);
      totalBytes += manifestBytes.byteLength;
      if (totalBytes > runtime.config.maxBackupBytes) {
        throw new HttpError(413, "BACKUP_TOO_LARGE", "备份内容超过大小限制");
      }

      const archivePath = path.join(
        path.dirname(runtime.dbPath),
        `excalidraw-full-backup-${timestamp}-${randomHex(4)}.tar`,
      );
      const archiveWriter = Bun.file(archivePath).writer({
        highWaterMark: 64 * 1024,
      });
      try {
        await writeTarFile(
          archiveWriter,
          "excalidraw.db",
          snapshot.tempBackupFile,
          databaseFile.size,
        );
        await writeTarBytes(archiveWriter, "manifest.json", manifestBytes);

        for (const row of fileRows) {
          if (!row.storage_path) {
            continue;
          }
          const filePath = getFilePath(runtime, row.id);
          if (!(await fileExists(filePath))) {
            throw new Error(`附件文件缺失：${row.id}`);
          }
          const file = Bun.file(filePath);
          totalBytes += file.size;
          if (totalBytes > runtime.config.maxBackupBytes) {
            throw new HttpError(413, "BACKUP_TOO_LARGE", "备份内容超过大小限制");
          }
          await writeTarFile(archiveWriter, `files/${row.id}`, filePath, file.size);
        }
        await archiveWriter.write(new Uint8Array(TAR_BLOCK_SIZE * 2));
        await archiveWriter.end();
      } catch (error) {
        await Promise.resolve(archiveWriter.end()).catch(() => {});
        await fs.promises.rm(archivePath, { force: true }).catch(() => {});
        throw error;
      }

      const archiveFile = Bun.file(archivePath);
      return {
        archivePath,
        size: archiveFile.size,
        cleanup: () => fs.promises.rm(archivePath, { force: true }),
      };
    } finally {
      await snapshot.cleanup().catch(() => {});
    }
  });
