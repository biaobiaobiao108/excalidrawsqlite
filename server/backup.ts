import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

import {
  fileExists,
  getFilePath,
  withStorageMutationLock,
} from "./files";

import type { ServerRuntime } from "./types";

export const createDatabaseSnapshot = async (
  runtime: ServerRuntime,
  timestamp: string,
) => {
  const tempBackupFile = path.join(
    path.dirname(runtime.dbPath),
    `excalidraw-backup-${timestamp}-${randomBytes(4).toString("hex")}.db`,
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

      const entries: Record<string, string | Uint8Array> = {
        "excalidraw.db": new Uint8Array(
          await Bun.file(snapshot.tempBackupFile).arrayBuffer(),
        ),
        "manifest.json": JSON.stringify(
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
        ),
      };

      for (const row of fileRows) {
        if (!row.storage_path) {
          continue;
        }
        const filePath = getFilePath(runtime, row.id);
        if (!(await fileExists(filePath))) {
          throw new Error(`附件文件缺失：${row.id}`);
        }
        entries[`files/${row.id}`] = new Uint8Array(
          await Bun.file(filePath).arrayBuffer(),
        );
      }

      const archive = new Bun.Archive(entries);
      return await archive.blob();
    } finally {
      await snapshot.cleanup().catch(() => {});
    }
  });
