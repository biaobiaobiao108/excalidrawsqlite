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
import { closeDevReloadSubscribers } from "./dev-reload";
import { createRequestHandler } from "./routes";
import { createRuntime } from "./runtime";
import { resolveProjectPath } from "./paths";

import type { ServerRuntime } from "./types";

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

type StoppableServer = {
  stop: (closeActiveConnections?: boolean) => Promise<void> | void;
};

type ShutdownResult = { forced: boolean };

export const shutdownServer = async (options: {
  server: StoppableServer;
  runtime: ServerRuntime;
  closeDevWatcher?: (() => void) | null;
  maintenanceTimer?: ReturnType<typeof setInterval>;
  backgroundTasks?: ReadonlySet<Promise<unknown>>;
  timeoutMs?: number;
}): Promise<ShutdownResult> => {
  const {
    server,
    runtime,
    closeDevWatcher,
    maintenanceTimer,
    backgroundTasks = new Set(),
    timeoutMs = 15_000,
  } = options;

  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
  }
  try {
    closeDevWatcher?.();
  } catch {
    // Ignore watcher shutdown failures while closing the server.
  }
  await closeDevReloadSubscribers();

  let gracefulError: unknown;
  const gracefulStop = Promise.all([
    Promise.resolve(server.stop()),
    ...backgroundTasks,
  ]).catch((error) => {
    gracefulError = error;
  });
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timedOut = await Promise.race([
    gracefulStop.then(() => false),
    new Promise<boolean>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }

  if (timedOut || gracefulError) {
    console.error("[Server] 优雅关闭超时，正在强制断开连接");
    try {
      await server.stop(true);
    } catch (error) {
      console.error("[Server] 强制关闭失败", error);
    }
    return { forced: true };
  }

  try {
    runtime.db.run("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch (error) {
    console.error("[Database] Shutdown WAL checkpoint failed", error);
  }
  try {
    runtime.db.close();
  } catch {
    // Ignore close failures during process shutdown.
  }
  return { forced: false };
};

export const createShutdownSignalHandler = (
  shutdown: () => Promise<ShutdownResult>,
  exit: (code: number) => void = (code) => process.exit(code),
) => {
  let shutdownPromise: Promise<void> | null = null;
  return () => {
    if (shutdownPromise) {
      return;
    }
    shutdownPromise = shutdown()
      .then(({ forced }) => exit(forced ? 1 : 0))
      .catch((error) => {
        console.error("[Server] 关闭失败", error);
        exit(1);
      });
  };
};

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

  const backgroundTasks = new Set<Promise<unknown>>();
  const trackBackgroundTask = (task: Promise<unknown>) => {
    const tracked = task.then(
      () => undefined,
      (error) => {
        console.error("[Server] 后台维护任务失败", error);
      },
    );
    backgroundTasks.add(tracked);
    void tracked.then(() => backgroundTasks.delete(tracked));
  };

  const runMaintenance = () => {
    cleanupExpiredSessions(runtime, Date.now());
    cleanupExpiredRateLimits(runtime, Date.now());
    performDatabaseMaintenance(runtime);
    trackBackgroundTask(
      cleanupOrphanedFiles(runtime).catch((error) => {
        console.error("[Files] cleanup failed", error);
      }),
    );
    trackBackgroundTask(
      cleanupStaleFileArtifacts(runtime).catch((error) => {
        console.error("[Files] stale artifact cleanup failed", error);
      }),
    );
    trackBackgroundTask(
      inspectStorageConsistency(runtime).then((consistency) => {
        if (
          consistency.missingFiles.length ||
          consistency.untrackedFiles.length ||
          consistency.orphanedReferences
        ) {
          console.warn("[Storage] 一致性检查发现问题", consistency);
        }
      }),
    );
  };

  const server = Bun.serve({ hostname, port, fetch: handler });
  serverRef.current = server;
  console.info("[Server] 已启动", {
    address: `http://${hostname}:${server.port}`,
    dbPath,
    filesDir,
    staticDir,
  });
  trackBackgroundTask(
    cleanupOrphanedFiles(runtime).catch((error) => {
      console.error("[Files] initial cleanup failed", error);
    }),
  );
  trackBackgroundTask(
    cleanupStaleFileArtifacts(runtime).catch((error) => {
      console.error("[Files] initial stale artifact cleanup failed", error);
    }),
  );
  trackBackgroundTask(
    inspectStorageConsistency(runtime).then((consistency) => {
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
    }),
  );
  const maintenanceTimer = setInterval(runMaintenance, 60 * 60 * 1000);

  const handleShutdown = createShutdownSignalHandler(() => {
    console.log("\n[Server] 正在优雅关闭...");
    return shutdownServer({
      server,
      runtime,
      closeDevWatcher,
      maintenanceTimer,
      backgroundTasks,
    });
  });

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
