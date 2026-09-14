import fs from "node:fs";
import path from "node:path";

import { Database } from "bun:sqlite";

import { createServerConfig } from "./config";
import { initializeDatabase, migrateLegacyDatabase } from "./database";
import { BodyMemoryBudget } from "./types";

import type { ServerConfig, ServerRuntime } from "./types";

export const createRuntime = (options: {
  dbPath: string;
  filesDir: string;
  staticDir?: string;
  config?: ServerConfig;
}): ServerRuntime => {
  const dbPath = path.resolve(options.dbPath);
  const filesDir = path.resolve(options.filesDir);
  const config = options.config || createServerConfig();
  let db: Database | undefined;

  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(filesDir, { recursive: true });
    fs.accessSync(path.dirname(dbPath), fs.constants.W_OK);
    fs.accessSync(filesDir, fs.constants.W_OK);
    db = new Database(dbPath, { create: true });
    initializeDatabase(db);
    migrateLegacyDatabase(db, filesDir);

    return {
      db,
      dbPath,
      filesDir,
      staticDir: options.staticDir
        ? path.resolve(options.staticDir)
        : undefined,
      config,
      sessions: new Map(),
      authAttempts: new Map(),
      writeAttempts: new Map(),
      bodyMemoryBudget: new BodyMemoryBudget(config.maxInFlightBodyBytes),
    };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Ignore cleanup failures while reporting the initialization error.
    }
    throw new Error(
      `无法初始化持久化存储（数据库：${dbPath}，文件目录：${filesDir}）`,
      { cause: error },
    );
  }
};
