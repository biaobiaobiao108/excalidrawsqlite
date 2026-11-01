import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { initializeDatabase } from "../../server/database";

test("rejects incompatible existing tables before modifying the database", () => {
  const db = new Database(":memory:");
  try {
    initializeDatabase(db);
    db.run("ALTER TABLE files ADD COLUMN unexpected TEXT");
    db.run(
      "INSERT INTO files (id, mime_type, created_at, updated_at) VALUES ('kept', 'image/png', 1, 1)",
    );
    const before = db
      .query("SELECT sql FROM sqlite_master ORDER BY name")
      .all();
    expect(() => initializeDatabase(db)).toThrow("files");
    expect(
      db.query("SELECT sql FROM sqlite_master ORDER BY name").all(),
    ).toEqual(before);
    expect(db.query("SELECT id FROM files").get()).toEqual({ id: "kept" });
  } finally {
    db.close();
  }
});

test("does not silently create missing tables in a partial existing database", () => {
  const db = new Database(":memory:");
  try {
    db.run("CREATE TABLE files(id TEXT PRIMARY KEY, mime_type TEXT NOT NULL)");
    expect(() => initializeDatabase(db)).toThrow("table:scenes");
    expect(
      db.query("SELECT name FROM sqlite_master WHERE name = 'scenes'").get(),
    ).toBeNull();
  } finally {
    db.close();
  }
});

test("rejects a known index name with a different definition", () => {
  const db = new Database(":memory:");
  try {
    initializeDatabase(db);
    db.run("DROP INDEX idx_files_updated_at");
    db.run("CREATE INDEX idx_files_updated_at ON files(created_at)");
    expect(() => initializeDatabase(db)).toThrow("idx_files_updated_at");
  } finally {
    db.close();
  }
});
