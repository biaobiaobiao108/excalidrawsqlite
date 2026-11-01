import { Database } from "bun:sqlite";
import type { ServerRuntime } from "./types";

// Version 1 is the schema used by releases before versioned migrations.
// Do not change it after release; add a new migration instead.
const createBaselineSchema = (db: Database) => {
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
      thumbnail_file_id TEXT,
      deleted_at INTEGER,
      element_count INTEGER NOT NULL DEFAULT 0,
      content_bytes INTEGER NOT NULL DEFAULT 0,
      content_sha256 TEXT NOT NULL DEFAULT ''
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      icon TEXT NOT NULL DEFAULT 'folder',
      color TEXT NOT NULL DEFAULT '#315f4c',
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

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  // Retain tombstones when boards are removed: a retry must not resurrect one.
  db.run(`
    CREATE TABLE IF NOT EXISTS scene_create_requests (
      key_sha256 TEXT PRIMARY KEY,
      payload_sha256 TEXT NOT NULL,
      scene_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scene_create_requests_expiry ON scene_create_requests(expires_at)",
  );

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
    "CREATE INDEX IF NOT EXISTS idx_scenes_active_updated_at ON scenes(updated_at DESC) WHERE deleted_at IS NULL",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scenes_active_updated_id ON scenes(updated_at DESC, id DESC) WHERE deleted_at IS NULL",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scenes_trash_deleted_at ON scenes(deleted_at DESC) WHERE deleted_at IS NOT NULL",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scenes_trash_deleted_id ON scenes(deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scenes_active_folder_id ON scenes(folder_id) WHERE deleted_at IS NULL",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scenes_active_folder_updated_id ON scenes(folder_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scenes_active_created_id ON scenes(created_at DESC, id DESC) WHERE deleted_at IS NULL",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scenes_active_folder_created_id ON scenes(folder_id, created_at DESC, id DESC) WHERE deleted_at IS NULL",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scenes_active_opened_id ON scenes(last_opened_at DESC, id DESC) WHERE deleted_at IS NULL",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scenes_thumbnail_file_id ON scenes(thumbnail_file_id)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_scene_files_file_id ON scene_files(file_id)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_files_updated_at ON files(updated_at)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)",
  );
};

export const BASELINE_SCHEMA_VERSION = 1;
export const CURRENT_SCHEMA_VERSION = 1;

export type SchemaMigration = {
  sourceVersion: number;
  targetVersion: number;
  migrate: (db: Database) => void;
};

export type DatabaseInitializationOptions = {
  migrations?: readonly SchemaMigration[];
  currentSchemaVersion?: number;
};

// Add only consecutive transitions; released migrations must not be rewritten.
const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [];

const readSchemaVersion = (db: Database) =>
  Number(
    (db.query("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );

const isEmptyDatabase = (db: Database) =>
  Number(
    (
      db
        .query(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type IN ('table', 'view', 'index', 'trigger') AND name NOT GLOB 'sqlite_*'",
        )
        .get() as { count: number }
    ).count,
  ) === 0;

export class DatabaseSchemaError extends Error {}

const schemaVersionError = (version: number, current: number) =>
  new DatabaseSchemaError(
    `SQLite schema version ${version} 不受支持；支持版本 ${BASELINE_SCHEMA_VERSION} 至 ${current}，数据库未修改`,
  );

const schemaSnapshot = (db: Database) => {
  const rows = db
    .query(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND sql IS NOT NULL",
    )
    .all() as Array<{ type: string; name: string; sql: string }>;
  return new Map(
    rows.map(({ type, name, sql }) => [
      `${type}:${name}`,
      sql.replace(/\s+/g, " ").replace(/"/g, "").trim(),
    ]),
  );
};

const assertSchemaMatches = (
  db: Database,
  expected: Database,
  version: number,
) => {
  const actualObjects = schemaSnapshot(db);
  const expectedObjects = schemaSnapshot(expected);
  const missing = [...expectedObjects.keys()].filter(
    (key) => !actualObjects.has(key),
  );
  const extra = [...actualObjects.keys()].filter(
    (key) => !expectedObjects.has(key),
  );
  const changed = [...expectedObjects.keys()].filter(
    (key) =>
      actualObjects.has(key) &&
      actualObjects.get(key) !== expectedObjects.get(key),
  );
  if (missing.length || extra.length || changed.length) {
    const details = [
      missing.length ? `缺少 [${missing.join(", ")}]` : "",
      extra.length ? `多余 [${extra.join(", ")}]` : "",
      changed.length ? `定义不一致 [${changed.join(", ")}]` : "",
    ]
      .filter(Boolean)
      .join("；");
    throw new DatabaseSchemaError(
      `SQLite schema version ${version} 不兼容：${details}；数据库未修改`,
    );
  }
};

// These indexes were added after the first unversioned folder schemas.
const legacyOptionalIndexes = [
  "idx_scenes_active_created_id",
  "idx_scenes_active_folder_created_id",
  "idx_scenes_active_opened_id",
] as const;

const normalizeLegacyFolderSql = (sql: string) =>
  sql.replace(/[\s"]/g, "").toLowerCase();
const knownLegacyFolderSchemas = new Set(
  [
    `CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    icon TEXT NOT NULL DEFAULT 'folder', color TEXT NOT NULL DEFAULT '#315f4c')`,
    `CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT 'folder', color TEXT NOT NULL DEFAULT '#315f4c',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  ].map(normalizeLegacyFolderSql),
);

const upgradeKnownUnversionedSchema = (db: Database, baseline: Database) => {
  const actual = schemaSnapshot(db);
  const expected = schemaSnapshot(baseline);
  for (const name of legacyOptionalIndexes) {
    const key = `index:${name}`;
    if (actual.has(key) && actual.get(key) !== expected.get(key)) return false;
    actual.delete(key);
    expected.delete(key);
  }
  const actualFolders = actual.get("table:folders");
  const baselineFolders = expected.get("table:folders");
  const rebuildFolders = Boolean(
    actualFolders &&
    knownLegacyFolderSchemas.has(normalizeLegacyFolderSql(actualFolders)),
  );
  if (!actualFolders || (!rebuildFolders && actualFolders !== baselineFolders))
    return false;
  actual.delete("table:folders");
  expected.delete("table:folders");
  if (
    actual.size !== expected.size ||
    [...expected].some(([key, sql]) => actual.get(key) !== sql)
  )
    return false;

  if (rebuildFolders) {
    if (
      db
        .query(
          "SELECT 1 FROM folders GROUP BY name HAVING COUNT(*) > 1 LIMIT 1",
        )
        .get()
    )
      throw new DatabaseSchemaError(
        "SQLite 旧库文件夹存在重名，无法自动升级；数据库未修改",
      );
    const folderSql = (
      baseline
        .query(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'folders'",
        )
        .get() as { sql: string }
    ).sql;
    db.run("ALTER TABLE folders RENAME TO folders_legacy_v0");
    db.run(folderSql);
    db.run(
      "INSERT INTO folders (id, name, icon, color, created_at, updated_at) SELECT id, name, icon, color, created_at, updated_at FROM folders_legacy_v0",
    );
    db.run("DROP TABLE folders_legacy_v0");
  }
  for (const name of legacyOptionalIndexes) {
    if (
      !db
        .query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(name)
    ) {
      const { sql } = baseline
        .query(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
        )
        .get(name) as { sql: string };
      db.run(sql);
    }
  }
  return true;
};

const findMigration = (
  migrations: readonly SchemaMigration[],
  sourceVersion: number,
) => {
  const matches = migrations.filter(
    (migration) => migration.sourceVersion === sourceVersion,
  );
  if (matches.length !== 1 || matches[0]!.targetVersion !== sourceVersion + 1)
    throw new DatabaseSchemaError(
      `SQLite schema migration ${sourceVersion} -> ${sourceVersion + 1} 缺失或不连续，数据库未修改`,
    );
  return matches[0]!;
};

const createSchemaAtVersion = (
  version: number,
  migrations: readonly SchemaMigration[],
) => {
  // Replaying migrations on an empty baseline derives each version's schema.
  // Migration callbacks must therefore work with an empty database as well.
  const expected = new Database(":memory:");
  try {
    expected.run("PRAGMA foreign_keys = ON");
    createBaselineSchema(expected);
    expected.run(`PRAGMA user_version = ${BASELINE_SCHEMA_VERSION}`);
    for (let source = BASELINE_SCHEMA_VERSION; source < version; source++) {
      const migration = findMigration(migrations, source);
      expected
        .transaction(() => {
          migration.migrate(expected);
          expected.run(`PRAGMA user_version = ${migration.targetVersion}`);
        })
        .immediate();
    }
    return expected;
  } catch (error) {
    expected.close();
    throw error;
  }
};

export const applyMigrations = (
  db: Database,
  migrations: readonly SchemaMigration[] = SCHEMA_MIGRATIONS,
  currentSchemaVersion = CURRENT_SCHEMA_VERSION,
) => {
  let version = readSchemaVersion(db);
  if (version < BASELINE_SCHEMA_VERSION || version > currentSchemaVersion)
    throw schemaVersionError(version, currentSchemaVersion);
  for (let source = version; source < currentSchemaVersion; source++)
    findMigration(migrations, source);
  while (version < currentSchemaVersion) {
    const migration = findMigration(migrations, version);
    const expectedBefore = createSchemaAtVersion(version, migrations);
    let expectedAfter: Database | undefined;
    try {
      expectedAfter = createSchemaAtVersion(
        migration.targetVersion,
        migrations,
      );
      const target = expectedAfter;
      db.transaction(() => {
        const current = readSchemaVersion(db);
        if (
          current >= migration.targetVersion &&
          current <= currentSchemaVersion
        )
          return;
        if (current !== migration.sourceVersion)
          throw schemaVersionError(current, currentSchemaVersion);
        assertSchemaMatches(db, expectedBefore, current);
        migration.migrate(db);
        assertSchemaMatches(db, target, migration.targetVersion);
        db.run(`PRAGMA user_version = ${migration.targetVersion}`);
      }).immediate();
    } finally {
      expectedBefore.close();
      expectedAfter?.close();
    }
    version = readSchemaVersion(db);
    if (version > currentSchemaVersion)
      throw schemaVersionError(version, currentSchemaVersion);
  }
};

export const initializeDatabase = (
  db: Database,
  options: DatabaseInitializationOptions = {},
) => {
  const migrations = options.migrations ?? SCHEMA_MIGRATIONS;
  const current = options.currentSchemaVersion ?? CURRENT_SCHEMA_VERSION;
  if (!Number.isSafeInteger(current) || current < BASELINE_SCHEMA_VERSION)
    throw schemaVersionError(current, CURRENT_SCHEMA_VERSION);
  for (let source = BASELINE_SCHEMA_VERSION; source < current; source++)
    findMigration(migrations, source);
  db.run("PRAGMA busy_timeout = 10000");
  db.run("PRAGMA foreign_keys = ON");
  let version = readSchemaVersion(db);
  if (version > current) throw schemaVersionError(version, current);
  if (version === 0) {
    const baseline = createSchemaAtVersion(BASELINE_SCHEMA_VERSION, migrations);
    try {
      if (isEmptyDatabase(db)) db.run("PRAGMA auto_vacuum = INCREMENTAL");
      db.transaction(() => {
        const lockedVersion = readSchemaVersion(db);
        if (lockedVersion !== 0) return;
        if (isEmptyDatabase(db)) createBaselineSchema(db);
        else upgradeKnownUnversionedSchema(db, baseline);
        assertSchemaMatches(db, baseline, BASELINE_SCHEMA_VERSION);
        db.run(`PRAGMA user_version = ${BASELINE_SCHEMA_VERSION}`);
      }).immediate();
    } finally {
      baseline.close();
    }
    version = readSchemaVersion(db);
  }
  db.transaction(() => {
    const storedVersion = readSchemaVersion(db);
    if (storedVersion < BASELINE_SCHEMA_VERSION || storedVersion > current)
      throw schemaVersionError(storedVersion, current);
    const expected = createSchemaAtVersion(storedVersion, migrations);
    try {
      assertSchemaMatches(db, expected, storedVersion);
    } finally {
      expected.close();
    }
  })();
  applyMigrations(db, migrations, current);
  const finalSchema = createSchemaAtVersion(current, migrations);
  try {
    assertSchemaMatches(db, finalSchema, current);
  } finally {
    finalSchema.close();
  }
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = FULL");
  db.run("PRAGMA wal_autocheckpoint = 1000");
  db.run("PRAGMA optimize=0x10002");
};

export const performDatabaseMaintenance = (runtime: ServerRuntime) => {
  try {
    runtime.db
      .query("DELETE FROM scene_create_requests WHERE expires_at <= ?")
      .run(Date.now());
    runtime.db.run("PRAGMA wal_checkpoint(PASSIVE);");
  } catch (error) {
    console.info("[Database] WAL checkpoint failed", error);
  }
};
