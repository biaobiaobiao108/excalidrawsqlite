import type { Database } from "bun:sqlite";

export type ServerConfig = {
  authPassword: string;
  allowAnonymous: boolean;
  nodeEnv: string;
  trustProxy: boolean;
  corsOrigins: Set<string>;
  maxFileBytes: number;
  maxSceneBodyBytes: number;
  maxFilesBodyBytes: number;
  sessionTtlMs: number;
};
export type RequestAddressResolver = (req: Request) => string | undefined;

export type ServerRuntime = {
  db: Database;
  dbPath: string;
  filesDir: string;
  staticDir?: string;
  config: ServerConfig;
  sessions: Map<string, number>;
  authAttempts: Map<string, { startedAt: number; count: number }>;
  writeAttempts: Map<string, { startedAt: number; count: number }>;
};
