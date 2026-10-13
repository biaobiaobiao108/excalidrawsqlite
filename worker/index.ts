import { createMcpRequestHandler, MCP_PATH } from "../server/mcp";
import { createRequestHandler } from "../server/routes";
import { cleanupExpiredRateLimits, cleanupExpiredSessions } from "../server/auth";
import { cleanupExpiredTrashScenes } from "../server/scenes";
import { cleanupOrphanedFiles, cleanupStaleFileArtifacts, cleanupUntrackedFiles } from "../server/files";
import { createCloudflareRuntime, type CloudflareEnv } from "../server/cloudflare-runtime";
import { handleCloudflareRealtimeRequest, RealtimeHub } from "../server/cloudflare-realtime";
import { REALTIME_ROUTE } from "../server/cloudflare-realtime";

type ExecutionContext = { waitUntil(promise: Promise<unknown>): void };

export { RealtimeHub };

export default {
  async fetch(request: Request, env: CloudflareEnv, context: ExecutionContext) {
    const runtime = createCloudflareRuntime(env, context, request);
    const pathname = new URL(request.url).pathname;
    if (pathname === REALTIME_ROUTE) {
      return handleCloudflareRealtimeRequest(request, runtime, env.REALTIME_HUB);
    }
    const apiHandler = createRequestHandler(runtime, () => runtime.clientAddress);
    if (pathname === MCP_PATH || pathname.startsWith(`${MCP_PATH}/`)) {
      return createMcpRequestHandler(runtime, apiHandler).fetch(request);
    }
    return apiHandler(request);
  },

  async scheduled(_event: { scheduledTime: number; cron: string }, env: CloudflareEnv, context: ExecutionContext) {
    const syntheticRequest = new Request("https://worker.internal/api/maintenance");
    const runtime = createCloudflareRuntime(env, context, syntheticRequest);
    const tasks = [
      cleanupExpiredSessions(runtime, Date.now()),
      cleanupExpiredRateLimits(runtime, Date.now()),
      cleanupExpiredTrashScenes(runtime),
      cleanupOrphanedFiles(runtime),
      cleanupStaleFileArtifacts(runtime),
      cleanupUntrackedFiles(runtime),
    ];
    context.waitUntil(Promise.all(tasks).then(() => undefined));
  },
};
