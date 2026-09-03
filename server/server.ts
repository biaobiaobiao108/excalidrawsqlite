import path from "node:path";

import {
  cleanupExpiredRateLimits,
  cleanupExpiredSessions,
} from "./auth";
import { DEFAULT_PORT } from "./config";
import { performDatabaseMaintenance } from "./database";
import {
  cleanupOrphanedFiles,
  cleanupStaleFileArtifacts,
  inspectStorageConsistency,
} from "./files";
import { createRequestHandler } from "./routes";
import { createRuntime } from "./runtime";
import { resolveProjectPath } from "./paths";

export { createServerConfig } from "./config";
export {
  initializeDatabase,
  performDatabaseMaintenance,
} from "./database";
export {
  cleanupExpiredRateLimits,
  cleanupExpiredSessions,
} from "./auth";
export { createRuntime } from "./runtime";
export {
  cleanupStaleFileArtifacts,
  inspectStorageConsistency,
} from "./files";
export { createRequestHandler } from "./routes";
export type { RequestAddressResolver, ServerConfig, ServerRuntime } from "./types";

export const startServer = async () => {
  const dataDir = resolveProjectPath(process.env.DATA_DIR, "data");
  const dbPath = resolveProjectPath(
    process.env.DB_PATH,
    path.join(dataDir, "excalidraw.db"),
  );
  const filesDir = resolveProjectPath(
    process.env.FILES_DIR,
    path.join(dataDir, "files"),
  );
  const staticDir = resolveProjectPath(
    process.env.STATIC_DIR,
    "excalidraw-app/build",
  );
  const runtime = createRuntime({ dbPath, filesDir, staticDir });
  const serverRef: { current?: ReturnType<typeof Bun.serve> } = {};
  const handler = createRequestHandler(
    runtime,
    (req) => serverRef.current?.requestIP(req)?.address,
  );
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const hostname = process.env.HOST || "0.0.0.0";
  const isDev =
    process.argv.includes("--dev") || process.env.NODE_ENV === "development";

  let closeDevWatcher: (() => void) | null = null;
  if (isDev) {
    const { startDevWatcher } = await import("./dev-server");
    closeDevWatcher = await startDevWatcher();
  }

  const runMaintenance = () => {
    cleanupExpiredSessions(runtime, Date.now());
    cleanupExpiredRateLimits(runtime, Date.now());
    performDatabaseMaintenance(runtime);
    void cleanupOrphanedFiles(runtime).catch((error) =>
      console.error("[Files] cleanup failed", error),
    );
    void cleanupStaleFileArtifacts(runtime).catch((error) =>
      console.error("[Files] stale artifact cleanup failed", error),
    );
    void inspectStorageConsistency(runtime).then((consistency) => {
      if (
        consistency.missingFiles.length ||
        consistency.untrackedFiles.length ||
        consistency.orphanedReferences
      ) {
        console.warn("[Storage] 一致性检查发现问题", consistency);
      }
    });
  };

  const server = Bun.serve({ hostname, port, fetch: handler });
  serverRef.current = server;
  console.info("[Server] 已启动", {
    address: `http://${hostname}:${server.port}`,
    dbPath,
    filesDir,
    staticDir,
  });
  void cleanupOrphanedFiles(runtime).catch((error) =>
    console.error("[Files] initial cleanup failed", error),
  );
  void cleanupStaleFileArtifacts(runtime).catch((error) =>
    console.error("[Files] initial stale artifact cleanup failed", error),
  );
  void inspectStorageConsistency(runtime).then((consistency) => {
    if (
      consistency.missingFiles.length ||
      consistency.untrackedFiles.length ||
      consistency.orphanedReferences
    ) {
      console.warn(
        "[Storage] initial consistency check found issues",
        consistency,
      );
    }
  });
  setInterval(runMaintenance, 60 * 60 * 1000);

  const handleShutdown = () => {
    console.log("\n[Server] 正在优雅关闭...");
    if (closeDevWatcher) {
      try {
        closeDevWatcher();
      } catch {
        // ignore
      }
    }
    try {
      runtime.db.run("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch (error) {
      console.error("[Database] Shutdown WAL checkpoint failed", error);
    }
    try {
      runtime.db.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  console.log(`[Database] SQLite initialized at: ${dbPath}`);
  console.log(`[Files] Persistent file directory: ${filesDir}`);
  if (isDev) {
    console.log(`⚡ Development mode active (Live Reload enabled)`);
  }
  console.log(`🚀 Excalidraw server is running at http://localhost:${port}`);
};

if (import.meta.main) {
  if (typeof process !== "undefined") {
    process.title = "excalidrawsqlite";
  }
  await startServer();
}
