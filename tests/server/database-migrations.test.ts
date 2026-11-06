import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";

import {
  applyMigrations,
  CURRENT_SCHEMA_VERSION,
  initializeDatabase,
  type SchemaMigration,
} from "../../server/database";

const databases: Database[] = [];

const createDatabase = () => {
  const db = new Database(":memory:");
  databases.push(db);
  return db;
};

const userVersion = (db: Database) =>
  (db.query("PRAGMA user_version").get() as { user_version: number })
    .user_version;

const schemaSnapshot = (db: Database) =>
  db
    .query(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    )
    .all();

const makeLegacyFolders = (db: Database) => {
  for (const name of [
    "idx_scenes_active_created_id",
    "idx_scenes_active_folder_created_id",
    "idx_scenes_active_opened_id",
  ])
    db.run(`DROP INDEX ${name}`);
  db.run("ALTER TABLE folders RENAME TO folders_current");
  db.run(
    "CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  );
  db.run("ALTER TABLE folders ADD COLUMN icon TEXT NOT NULL DEFAULT 'folder'");
  db.run(
    "ALTER TABLE folders ADD COLUMN color TEXT NOT NULL DEFAULT '#315f4c'",
  );
  db.run(
    "INSERT INTO folders (id, name, icon, color, created_at, updated_at) SELECT id, name, icon, color, created_at, updated_at FROM folders_current",
  );
  db.run("DROP TABLE folders_current");
  db.run("PRAGMA user_version = 0");
};

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("SQLite database migrations", () => {
  it("initializes an empty database at the current schema version", () => {
    const db = createDatabase();

    initializeDatabase(db);

    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scenes'",
        )
        .get(),
    ).toEqual({ name: "scenes" });
  });

  it("adopts a complete unversioned baseline without losing stored data", () => {
    const db = createDatabase();
    initializeDatabase(db, { currentSchemaVersion: 1 });
    db.query(
      "INSERT INTO folders (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run("folder-1", "Existing folder", 100, 200);
    db.run("PRAGMA user_version = 0");

    initializeDatabase(db);

    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      db.query("SELECT id, name, created_at, updated_at FROM folders").get(),
    ).toEqual({
      id: "folder-1",
      name: "Existing folder",
      created_at: 100,
      updated_at: 200,
    });
  });

  it("upgrades the known unversioned folder layout and missing indexes", () => {
    const db = createDatabase();
    initializeDatabase(db, { currentSchemaVersion: 1 });
    db.run(
      "INSERT INTO folders (id, name, icon, color, created_at, updated_at) VALUES ('f', 'old', 'star', '#123456', 1, 2)",
    );
    db.run(
      "INSERT INTO scenes (id, name, elements, app_state, created_at, updated_at, folder_id) VALUES ('s', 'scene', '[]', '{}', 1, 2, 'f')",
    );
    makeLegacyFolders(db);

    initializeDatabase(db);

    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.query("SELECT * FROM folders WHERE id = 'f'").get()).toEqual({
      id: "f",
      name: "old",
      icon: "star",
      color: "#123456",
      created_at: 1,
      updated_at: 2,
    });
    expect(
      db.query("SELECT folder_id FROM scenes WHERE id = 's'").get(),
    ).toEqual({ folder_id: "f" });
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE name = 'idx_scenes_active_opened_id'",
        )
        .get(),
    ).toBeTruthy();
  });

  it("restores known missing indexes in an otherwise current unversioned schema", () => {
    const db = createDatabase();
    initializeDatabase(db, { currentSchemaVersion: 1 });
    db.run("DROP INDEX idx_scenes_active_opened_id");
    db.run("PRAGMA user_version = 0");
    initializeDatabase(db);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE name = 'idx_scenes_active_opened_id'",
        )
        .get(),
    ).toBeTruthy();
  });

  it("rejects a modified historical index without changing an unversioned database", () => {
    const db = createDatabase();
    initializeDatabase(db, { currentSchemaVersion: 1 });
    db.run("DROP INDEX idx_scenes_active_opened_id");
    db.run("CREATE INDEX idx_scenes_active_opened_id ON scenes(name)");
    db.run("PRAGMA user_version = 0");
    const before = schemaSnapshot(db);
    expect(() => initializeDatabase(db)).toThrow("idx_scenes_active_opened_id");
    expect(userVersion(db)).toBe(0);
    expect(schemaSnapshot(db)).toEqual(before);
  });

  it("leaves legacy data and schema intact when duplicate folder names prevent upgrade", () => {
    const db = createDatabase();
    initializeDatabase(db, { currentSchemaVersion: 1 });
    makeLegacyFolders(db);
    db.run(
      "INSERT INTO folders (id, name, created_at, updated_at) VALUES ('a', 'same', 1, 1), ('b', 'same', 2, 2)",
    );
    const before = schemaSnapshot(db);

    expect(() => initializeDatabase(db)).toThrow("重名");

    expect(userVersion(db)).toBe(0);
    expect(schemaSnapshot(db)).toEqual(before);
    expect(db.query("SELECT COUNT(*) AS count FROM folders").get()).toEqual({
      count: 2,
    });
  });

  it("rejects unknown schema versions without changing the database", () => {
    const db = createDatabase();
    initializeDatabase(db);
    db.run("PRAGMA user_version = 9876");
    const before = schemaSnapshot(db);

    expect(() => initializeDatabase(db)).toThrow();

    expect(userVersion(db)).toBe(9876);
    expect(schemaSnapshot(db)).toEqual(before);
  });

  it("rejects schema drift without modifying the drifted database", () => {
    const db = createDatabase();
    initializeDatabase(db);
    db.run("ALTER TABLE scenes ADD COLUMN unexpected TEXT");
    const before = schemaSnapshot(db);

    expect(() => initializeDatabase(db)).toThrow();

    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(schemaSnapshot(db)).toEqual(before);
  });

  it("does not adopt an unversioned database when a required migration is missing", () => {
    const db = createDatabase();
    initializeDatabase(db, { currentSchemaVersion: 1 });
    db.run("PRAGMA user_version = 0");
    const before = schemaSnapshot(db);

    expect(() =>
      initializeDatabase(db, { currentSchemaVersion: 2, migrations: [] }),
    ).toThrow("1 -> 2");
    expect(userVersion(db)).toBe(0);
    expect(schemaSnapshot(db)).toEqual(before);
  });

  it("upgrades baseline boards while removing redundant indexes and the unused hash", () => {
    const db = createDatabase();
    initializeDatabase(db, { currentSchemaVersion: 1 });
    db.run(
      "INSERT INTO scenes(id,name,elements,app_state,created_at,updated_at,content_sha256) VALUES ('kept','board','[{\"id\":1}]','{}',1,2,'old-hash')",
    );
    initializeDatabase(db);
    expect(userVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      db.query("SELECT elements FROM scenes WHERE id='kept'").get(),
    ).toEqual({ elements: '[{"id":1}]' });
    expect(
      (
        db.query("PRAGMA table_info(scenes)").all() as Array<{ name: string }>
      ).some((column) => column.name === "content_sha256"),
    ).toBe(false);
    for (const name of [
      "idx_scenes_active_updated_at",
      "idx_scenes_trash_deleted_at",
      "idx_scenes_active_folder_id",
    ]) {
      expect(
        db
          .query("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
          .get(name),
      ).toBeNull();
    }
  });

  it("rolls back schema changes when a migration produces unexpected structure", () => {
    const db = createDatabase();
    initializeDatabase(db, { currentSchemaVersion: 1 });
    db.run(
      "INSERT INTO folders (id, name, created_at, updated_at) VALUES ('f', 'kept', 1, 1)",
    );
    const migrations: SchemaMigration[] = [
      {
        sourceVersion: 1,
        targetVersion: 2,
        migrate(database) {
          database.run("CREATE TABLE expected_migration (id INTEGER)");
          if (database.query("SELECT id FROM folders LIMIT 1").get())
            database.run("CREATE TABLE unexpected_migration (id INTEGER)");
        },
      },
    ];

    expect(() => applyMigrations(db, migrations, 2)).toThrow(
      "unexpected_migration",
    );
    expect(userVersion(db)).toBe(1);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE name = 'expected_migration'",
        )
        .get(),
    ).toBeNull();
    expect(db.query("SELECT name FROM folders").get()).toEqual({
      name: "kept",
    });
  });

  it("commits migrations step by step and rolls back a failed step", () => {
    const db = createDatabase();
    initializeDatabase(db, { currentSchemaVersion: 1 });
    db.query(
      "INSERT INTO scenes (id, name, elements, app_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("scene-1", "Existing scene", "[]", "{}", 100, 200);
    const migrations: SchemaMigration[] = [
      {
        sourceVersion: 1,
        targetVersion: 2,
        migrate(database) {
          database.run("CREATE TABLE completed_migration (id INTEGER)");
        },
      },
      {
        sourceVersion: 2,
        targetVersion: 3,
        migrate(database) {
          const hasExistingData = database
            .query("SELECT 1 AS found FROM scenes LIMIT 1")
            .get();
          if (hasExistingData) {
            database.run("CREATE TABLE failed_migration (id INTEGER)");
            throw new Error("migration failed");
          }
        },
      },
    ];

    expect(() => applyMigrations(db, migrations, 3)).toThrow(
      "migration failed",
    );

    expect(userVersion(db)).toBe(2);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get("completed_migration"),
    ).toEqual({ name: "completed_migration" });
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get("failed_migration"),
    ).toBeNull();
  });
});
