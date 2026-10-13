#!/usr/bin/env bun
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dir, "..");
const watchedDirectories = [
  path.join(projectRoot, "excalidraw-app"),
  path.join(projectRoot, "packages"),
  path.join(projectRoot, "public"),
];
const ignoredDirectoryNames = new Set(["build", "dist", "node_modules", "types"]);
const watchedFilePattern = /\.(?:html|[cm]?[jt]sx?|css|scss|json|svg|woff2?|ttf|otf)$/i;

const watchers: FSWatcher[] = [];
let buildProcess: ReturnType<typeof Bun.spawn> | null = null;
let worker: ReturnType<typeof Bun.spawn> | null = null;
let buildRunning = false;
let buildQueued = false;
let buildDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let stopping = false;
const workerStartWaiters: Array<() => void> = [];

const terminateProcessTree = async (child: ReturnType<typeof Bun.spawn>) => {
  if (process.platform === "win32") {
    const killer = Bun.spawn(
      ["taskkill", "/PID", String(child.pid), "/T", "/F"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    const killExitCode = await killer.exited;
    if (killExitCode !== 0) child.kill();
  } else {
    child.kill();
  }
  await child.exited;
};

const isBuildInput = (filename: string | Buffer | null) => {
  // A missing filename commonly means a watched directory was replaced. The
  // frontend build itself replaces its output tree, so treating that event as
  // a source change would cause an endless rebuild loop.
  if (filename === null) return false;
  const normalized = filename.toString().replaceAll("\\", "/");
  if (normalized.split("/").some((segment) => ignoredDirectoryNames.has(segment))) {
    return false;
  }
  return watchedFilePattern.test(normalized);
};

const runFrontendBuild = async () => {
  buildRunning = true;
  const restartWorker = worker !== null;
  let initialBuild = true;
  try {
    if (worker) {
      const previousWorker = worker;
      worker = null;
      await terminateProcessTree(previousWorker);
    }
    do {
      buildQueued = false;
      const child = Bun.spawn(
        [process.execPath, path.join(projectRoot, "scripts", "build-frontend.ts"), "--dev"],
        { cwd: projectRoot, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
      );
      buildProcess = child;
      const exitCode = await child.exited;
      if (buildProcess === child) buildProcess = null;
      if (exitCode !== 0) {
        console.info(`[dev] frontend build exited with code ${exitCode}`);
        if (initialBuild) throw new Error("Initial frontend build failed");
      }
      initialBuild = false;
    } while (buildQueued && !stopping);
  } finally {
    buildRunning = false;
    if (restartWorker && !stopping) startWorker();
  }
};

const scheduleFrontendBuild = () => {
  if (buildDebounceTimer) clearTimeout(buildDebounceTimer);
  buildDebounceTimer = setTimeout(() => {
    buildDebounceTimer = null;
    if (buildRunning) {
      buildQueued = true;
      return;
    }
    void runFrontendBuild().catch((error) => {
      console.info("[dev] frontend rebuild failed", error);
    });
  }, 100);
};

for (const directory of watchedDirectories) {
  watchers.push(watch(directory, { recursive: true }, (_eventType, filename) => {
    if (isBuildInput(filename)) scheduleFrontendBuild();
  }));
}

const startWorker = () => {
  if (stopping || worker) return;
  worker = Bun.spawn([process.execPath, "x", "wrangler", "dev"], {
    cwd: projectRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  for (const resolve of workerStartWaiters.splice(0)) resolve();
};

const stopWorker = async () => {
  if (!worker) return;
  const previousWorker = worker;
  worker = null;
  await terminateProcessTree(previousWorker);
};

// Bun's --watch follows this script's imported modules, while Bun.build reads
// frontend files as inputs. Watch those source trees explicitly instead. Stop
// Wrangler during output replacement because Windows keeps served asset files
// open and otherwise rejects the build's clean step with EBUSY.
try {
  await runFrontendBuild();
} catch (error) {
  for (const watcher of watchers) watcher.close();
  throw error;
}
startWorker();

const stop = async () => {
  if (stopping) return;
  stopping = true;
  if (buildDebounceTimer) clearTimeout(buildDebounceTimer);
  for (const watcher of watchers) watcher.close();
  if (buildProcess) await terminateProcessTree(buildProcess);
  const activeWorker = worker;
  worker = null;
  if (activeWorker) await terminateProcessTree(activeWorker);
};

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

let exitCode = 0;
while (!stopping) {
  const currentWorker = worker;
  if (!currentWorker) {
    await new Promise<void>((resolve) => workerStartWaiters.push(resolve));
    continue;
  }
  const currentExitCode = await currentWorker.exited;
  if (worker !== currentWorker) continue;
  worker = null;
  exitCode = currentExitCode;
  break;
}
await stop();
process.exitCode = exitCode;
