import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SCHEMA_VERSION } from "./config";
import { decodeDataUrl, extractFileIds } from "./files";
import { validateId } from "./validation";

import type { Database } from "bun:sqlite";
import type { ServerRuntime } from "./types";

const ensureColumn = (
  db: Database,
  table: string,
  column: string,
  definition: string,
) => {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (columns.length && !columns.some((item) => item.name === column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};

export const initializeDatabase = (db: Database) => {
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA busy_timeout = 10000;");
  db.run("PRAGMA synchronous = FULL;");
  db.run("PRAGMA wal_autocheckpoint = 1000;");

  db.run(`
    CREATE TABLE IF NOT EXISTS scenes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      elements TEXT NOT NULL,
      app_state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      tags_json TEXT NOT NULL DEFAULT '[]',
      is_favorite INTEGER NOT NULL DEFAULT 0,
      folder_id TEXT,
      last_opened_at INTEGER,
      thumbnail_file_id TEXT
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      storage_path TEXT,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scene_files (
      scene_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      PRIMARY KEY (scene_id, file_id),
      FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    );
  `);

  // Keep scene records usable if a database created by an earlier build is reused.
  ensureColumn(db, "scenes", "revision", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "scenes", "tags_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "scenes", "is_favorite", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "scenes", "folder_id", "TEXT");
  ensureColumn(db, "scenes", "last_opened_at", "INTEGER");
  ensureColumn(db, "scenes", "thumbnail_file_id", "TEXT");
  ensureColumn(db, "scenes", "deleted_at", "INTEGER");
  ensureColumn(db, "files", "storage_path", "TEXT");
  ensureColumn(db, "files", "byte_size", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "files", "sha256", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "files", "updated_at", "INTEGER NOT NULL DEFAULT 0");

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scenes_updated_at ON scenes(updated_at DESC)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scenes_last_opened_at ON scenes(last_opened_at DESC)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scenes_deleted_at ON scenes(deleted_at)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scenes_folder_id ON scenes(folder_id)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scene_files_file_id ON scene_files(file_id)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)",
  );
};

export const migrateLegacyDatabase = (db: Database, filesDir: string) => {
  const versionRow = db.query("PRAGMA user_version").get() as {
    user_version?: number;
  } | null;
  const version = Number(versionRow?.user_version) || 0;
  const fileColumns = db.query("PRAGMA table_info(files)").all() as Array<{
    name: string;
  }>;
  const hasLegacyDataUrl = fileColumns.some(
    (column) => column.name === "data_url",
  );

  if (version >= SCHEMA_VERSION && !hasLegacyDataUrl) {
    return;
  }
  if (!hasLegacyDataUrl && version === 0) {
    db.run(
      "UPDATE scenes SET last_opened_at = COALESCE(last_opened_at, updated_at)",
    );
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }

  let migratedFiles = 0;
  let invalidFiles = 0;
  if (hasLegacyDataUrl) {
    const legacyRows = db
      .query(
        `SELECT id, data_url, mime_type, created_at, storage_path
         FROM files
         WHERE data_url IS NOT NULL AND data_url <> ''`,
      )
      .all() as Array<{
      id: string;
      data_url: string;
      mime_type: string;
      created_at: number;
      storage_path: string | null;
    }>;

    for (const row of legacyRows) {
      try {
        const id = validateId(row.id, "file");
        const bytes = decodeDataUrl(row.data_url, row.mime_type);
        const filePath = path.resolve(filesDir, id);
        const tempPath = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
        try {
          fs.writeFileSync(tempPath, bytes);
          try {
            fs.renameSync(tempPath, filePath);
          } catch (error: any) {
            if (error?.code !== "EEXIST" && error?.code !== "EPERM") {
              throw error;
            }
            fs.rmSync(filePath, { force: true });
            fs.renameSync(tempPath, filePath);
          }
        } finally {
          fs.rmSync(tempPath, { force: true });
        }
        const hash = createHash("sha256").update(bytes).digest("hex");
        const now = Date.now();
        db.run(
          `UPDATE files
           SET storage_path = ?, byte_size = ?, sha256 = ?, updated_at = ?
           WHERE id = ?`,
          [id, bytes.byteLength, hash, now, id],
        );
        db.run("UPDATE files SET data_url = '' WHERE id = ?", [id]);
        migratedFiles += 1;
      } catch (error) {
        invalidFiles += 1;
        console.warn("[Migration] 无法迁移旧图片附件", {
          id: row.id,
          error: error instanceof Error ? error.message : error,
        });
      }
    }
  }

  db.run("DELETE FROM scene_files");
  const scenes = db.query("SELECT id, elements FROM scenes").all() as Array<{
    id: string;
    elements: string;
  }>;
  let references = 0;
  for (const scene of scenes) {
    try {
      const elements = JSON.parse(scene.elements || "[]");
      for (const fileId of extractFileIds(elements)) {
        const exists = db.query("SELECT 1 FROM files WHERE id = ?").get(fileId);
        if (!exists) {
          console.warn("[Migration] 场景引用的图片记录不存在", {
            sceneId: scene.id,
            fileId,
          });
          continue;
        }
        db.run(
          "INSERT OR IGNORE INTO scene_files (scene_id, file_id) VALUES (?, ?)",
          [scene.id, fileId],
        );
        references += 1;
      }
    } catch (error) {
      console.warn("[Migration] 无法重建场景图片引用", {
        sceneId: scene.id,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  db.run(
    "UPDATE scenes SET last_opened_at = COALESCE(last_opened_at, updated_at)",
  );
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  console.info("[Migration] 数据库迁移完成", {
    fromVersion: version,
    toVersion: SCHEMA_VERSION,
    migratedFiles,
    invalidFiles,
    scenes: scenes.length,
    references,
    filesDir,
  });
};

export const performDatabaseMaintenance = (runtime: ServerRuntime) => {
  try {
    runtime.db.run("PRAGMA wal_checkpoint(PASSIVE);");
  } catch (error) {
    console.error("[Database] WAL checkpoint failed", error);
  }
};
