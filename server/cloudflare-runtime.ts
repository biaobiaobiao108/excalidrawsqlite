import { createServerConfig } from "./config";
import { databaseFromBinding, type D1Binding } from "./db";
import { BodyMemoryBudget, type R2BucketBinding, type RealtimeNamespaceBinding, type ServerRuntime, type StaticAssetsBinding, type WorkerExecutionContext } from "./types";

export type CloudflareEnv = {
  DB: D1Binding;
  ASSETS_BUCKET: R2BucketBinding;
  ASSETS: StaticAssetsBinding;
  REALTIME_HUB: RealtimeNamespaceBinding;
  AUTH_PASSWORD?: string;
  ALLOW_ANONYMOUS?: string;
  MCP_TOKEN?: string;
  MCP_TRACE?: string;
  TRUST_PROXY?: string;
  CORS_ORIGIN?: string;
  AUTH_ATTEMPTS_PER_WINDOW?: string;
  MAX_FILE_BYTES?: string;
  MAX_SCENE_BODY_BYTES?: string;
  MAX_IN_FLIGHT_BODY_BYTES?: string;
  AUTH_SESSION_TTL_MS?: string;
  TRASH_RETENTION_DAYS?: string;
};

const envToConfig = (env: CloudflareEnv) => createServerConfig({
  AUTH_PASSWORD: env.AUTH_PASSWORD,
  ALLOW_ANONYMOUS: env.ALLOW_ANONYMOUS,
  MCP_TOKEN: env.MCP_TOKEN,
  MCP_TRACE: env.MCP_TRACE,
  TRUST_PROXY: "false",
  CORS_ORIGIN: env.CORS_ORIGIN,
  AUTH_ATTEMPTS_PER_WINDOW: env.AUTH_ATTEMPTS_PER_WINDOW,
  MAX_FILE_BYTES: env.MAX_FILE_BYTES,
  MAX_SCENE_BODY_BYTES: env.MAX_SCENE_BODY_BYTES,
  MAX_IN_FLIGHT_BODY_BYTES: env.MAX_IN_FLIGHT_BODY_BYTES,
  AUTH_SESSION_TTL_MS: env.AUTH_SESSION_TTL_MS,
  TRASH_RETENTION_DAYS: env.TRASH_RETENTION_DAYS,
  NODE_ENV: "production",
});

// A Worker isolate serves many concurrent requests, each of which gets a new
// ServerRuntime. Keep one aggregate body budget per configured isolate limit so
// those request-local runtimes cannot each reserve the full memory allowance.
const bodyMemoryBudgets = new Map<number, BodyMemoryBudget>();

const bodyMemoryBudgetForIsolate = (maxBytes: number) => {
  let budget = bodyMemoryBudgets.get(maxBytes);
  if (!budget) {
    budget = new BodyMemoryBudget(maxBytes);
    bodyMemoryBudgets.set(maxBytes, budget);
  }
  return budget;
};

export const createCloudflareRuntime = (
  env: CloudflareEnv,
  context: WorkerExecutionContext,
  request: Request,
): ServerRuntime => {
  const config = envToConfig(env);
  const runtime: ServerRuntime = {
    db: databaseFromBinding(env.DB),
    files: env.ASSETS_BUCKET,
    staticAssets: env.ASSETS,
    realtimeNamespace: env.REALTIME_HUB,
    waitUntil: (promise) => context.waitUntil(promise),
    config,
    clientAddress: request.headers.get("CF-Connecting-IP") || undefined,
    activeBackupArtifacts: new Set(),
    bodyMemoryBudget: bodyMemoryBudgetForIsolate(config.maxInFlightBodyBytes),
  };
  runtime.realtime = {
    publishSceneChanged: (event) => publish(runtime, event),
    publishWorkspaceChanged: (updatedAt = Date.now()) => publish(runtime, { type: "workspace_changed", updatedAt }),
  };
  return runtime;
};

const publish = (runtime: ServerRuntime, event: Record<string, unknown>) => {
  const namespace = runtime.realtimeNamespace;
  if (!namespace) return;
  const task = namespace.get(namespace.idFromName("workspace")).fetch(new Request(
    "https://realtime.internal/broadcast",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) },
  ));
  runtime.waitUntil?.(task);
};
