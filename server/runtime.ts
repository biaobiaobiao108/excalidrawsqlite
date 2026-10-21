import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { createServerConfig } from "./config";
import { initializeDatabase } from "./database";
import { BunDatabaseAdapter } from "./bun-database";
import { BodyMemoryBudget, type ServerRuntime } from "./types";

/** Test/local SQLite runtime; the Cloudflare Worker imports cloudflare-runtime.ts instead. */
export type LocalServerRuntime = Omit<ServerRuntime, "db" | "dbPath" | "filesDir"> & {
  db: BunDatabaseAdapter;
  dbPath: string;
  filesDir: string;
};

export const createRuntime = (options: { dbPath: string; filesDir: string; staticDir?: string; config?: ReturnType<typeof createServerConfig> }): LocalServerRuntime => {
  const config = options.config || createServerConfig();
  const dbPath = path.resolve(options.dbPath);
  const filesDir = path.resolve(options.filesDir);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(filesDir, { recursive: true });
  const sqlite = new Database(dbPath, { create: true });
  try {
    initializeDatabase(sqlite);
    return {
      db: new BunDatabaseAdapter(sqlite),
      dbPath,
      filesDir,
      activeBackupArtifacts: new Set(),
      activeFileArtifacts: new Set(),
      staticDir: options.staticDir ? path.resolve(options.staticDir) : undefined,
      config,
      bodyMemoryBudget: new BodyMemoryBudget(config.maxInFlightBodyBytes),
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
};
