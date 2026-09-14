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
      const entries: Record<string, string | Uint8Array> = {
        "excalidraw.db": new Uint8Array(),
        "manifest.json": manifest,
      };

      const databaseFile = Bun.file(snapshot.tempBackupFile);
      let totalBytes = databaseFile.size;
      if (totalBytes > runtime.config.maxBackupBytes) {
        throw new HttpError(413, "BACKUP_TOO_LARGE", "备份内容超过大小限制");
      }
      entries["excalidraw.db"] = new Uint8Array(
        await databaseFile.arrayBuffer(),
      );
      const manifestBytes = new TextEncoder().encode(manifest);
      totalBytes += manifestBytes.byteLength;
      if (totalBytes > runtime.config.maxBackupBytes) {
        throw new HttpError(413, "BACKUP_TOO_LARGE", "备份内容超过大小限制");
      }

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
        entries[`files/${row.id}`] = new Uint8Array(await file.arrayBuffer());
      }

      const archive = new Bun.Archive(entries);
      return await archive.blob();
    } finally {
      await snapshot.cleanup().catch(() => {});
    }
  });
