#!/usr/bin/env bun
import { spawn } from "node:child_process";

const run = async (args: string[]) => {
  const child = Bun.spawn(args, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child;
};

await Bun.$`bun run build:frontend`.quiet();
const watcher = await run([process.execPath, "--watch", "scripts/build-frontend.ts"]);
const worker = await run([process.execPath, "x", "wrangler", "dev"]);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  watcher.kill();
  worker.kill();
  await Promise.all([watcher.exited, worker.exited]);
};

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

const result = await Promise.race([watcher.exited, worker.exited]);
await stop();
process.exitCode = result;
