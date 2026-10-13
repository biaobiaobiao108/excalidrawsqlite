import { isAuthorized } from "./auth";
import { isAllowedOrigin, jsonResponse } from "./http";
import { validateId } from "./validation";
import { REALTIME_PATH } from "./realtime";
import type { RealtimeNamespaceBinding, ServerRuntime } from "./types";

const MAX_CLIENT_MESSAGE_BYTES = 8 * 1024;
const MAX_BACKPRESSURE_BYTES = 256 * 1024;
const WORKSPACE_TOPIC = "workspace";

type SocketWithAttachment = WebSocket & {
  serializeAttachment(value: { sceneId: string | null }): void;
  deserializeAttachment(): { sceneId?: string | null } | null;
};
type DurableState = {
  acceptWebSocket(socket: SocketWithAttachment, tags?: string[]): void;
  getWebSockets(tag?: string): SocketWithAttachment[];
};

export const handleCloudflareRealtimeRequest = async (
  req: Request,
  runtime: ServerRuntime,
  namespace: RealtimeNamespaceBinding,
) => {
  if (req.method !== "GET") return jsonResponse(runtime, req, { error: "WebSocket 只支持 GET", code: "METHOD_NOT_ALLOWED" }, 405, { Allow: "GET" });
  if (!isAllowedOrigin(runtime, req)) return jsonResponse(runtime, req, { error: "不允许的跨域来源", code: "CORS_FORBIDDEN" }, 403);
  if (!(await isAuthorized(runtime, req))) return jsonResponse(runtime, req, { error: "请先完成访问授权", code: "AUTH_REQUIRED" }, 401);
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return jsonResponse(runtime, req, { error: "需要 WebSocket 升级", code: "UPGRADE_REQUIRED" }, 426, { Upgrade: "websocket" });

  const url = new URL(req.url);
  const sceneIdValue = url.searchParams.get("scene_id");
  let sceneId: string | null = null;
  if (sceneIdValue) {
    try { sceneId = validateId(sceneIdValue, "scene"); }
    catch { return jsonResponse(runtime, req, { error: "无效的资源 ID", code: "INVALID_ID" }, 400); }
  }
  const internal = new URL("https://realtime.internal/");
  if (sceneId) internal.searchParams.set("scene_id", sceneId);
  const realtime = namespace.get(namespace.idFromName("workspace"));
  const response = await realtime.fetch(new Request(internal, req));
  if (sceneId && response.status === 101) {
    // Read after the Durable Object has accepted the socket. Any save committed
    // before this read is reflected in this event; later saves are delivered by
    // the normal broadcast path, closing the reconnect race window.
    const scene = await runtime.db.query(
      "SELECT revision, updated_at, deleted_at FROM scenes WHERE id = ?",
    ).get<{ revision: number; updated_at: number; deleted_at: number | null }>(sceneId);
    if (scene) {
      await realtime.fetch(new Request("https://realtime.internal/sync-scene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sceneId,
          revision: Number(scene.revision) || 0,
          updatedAt: Number(scene.updated_at) || Date.now(),
          changeKind: scene.deleted_at ? "deleted" : "content",
        }),
      }));
    }
  }
  return response;
};

export class RealtimeHub {
  constructor(private readonly state: DurableState) {}

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/sync-scene") {
      const payload = await request.json() as {
        sceneId?: unknown;
        revision?: unknown;
        updatedAt?: unknown;
        changeKind?: unknown;
      };
      if (
        typeof payload.sceneId !== "string" ||
        typeof payload.revision !== "number" ||
        typeof payload.updatedAt !== "number" ||
        !["created", "content", "metadata", "thumbnail", "deleted", "restored"].includes(String(payload.changeKind))
      ) {
        return new Response("Invalid scene sync event", { status: 400 });
      }
      const event = JSON.stringify({ type: "scene_changed", ...payload });
      for (const socket of this.state.getWebSockets(WORKSPACE_TOPIC)) {
        const { sceneId } = socket.deserializeAttachment() || {};
        if (sceneId === payload.sceneId) this.send(socket, event);
      }
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && url.pathname === "/broadcast") {
      const payload = await request.json() as Record<string, unknown>;
      const serialized = JSON.stringify(payload);
      for (const socket of this.state.getWebSockets(WORKSPACE_TOPIC)) {
        const { sceneId } = socket.deserializeAttachment() || {};
        if (payload.type === "scene_changed" && sceneId === payload.sceneId) this.send(socket, serialized);
        if (payload.type === "workspace_changed") this.send(socket, serialized);
      }
      if (payload.type === "scene_changed") {
        const workspaceEvent = JSON.stringify({ type: "workspace_changed", updatedAt: payload.updatedAt });
        for (const socket of this.state.getWebSockets(WORKSPACE_TOPIC)) this.send(socket, workspaceEvent);
      }
      return new Response(null, { status: 204 });
    }
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426, headers: { Upgrade: "websocket" } });
    }
    const Pair = (globalThis as unknown as { WebSocketPair: new () => { 0: WebSocket; 1: SocketWithAttachment } }).WebSocketPair;
    const pair = new Pair();
    const client = pair[0];
    const server = pair[1];
    const sceneId = new URL(request.url).searchParams.get("scene_id");
    server.serializeAttachment({ sceneId });
    this.state.acceptWebSocket(server, [WORKSPACE_TOPIC, ...(sceneId ? [`scene:${sceneId}`] : [])]);
    server.send(JSON.stringify({ type: "ready", sceneId }));
    server.send(JSON.stringify({ type: "workspace_changed", updatedAt: Date.now() }));
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  webSocketMessage(socket: SocketWithAttachment, message: string | ArrayBuffer) {
    const bytes = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (bytes > MAX_CLIENT_MESSAGE_BYTES) return socket.close(1009, "message too large");
    let value: unknown;
    try { value = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)); }
    catch { return socket.close(1003, "invalid message"); }
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as { type?: unknown }).type !== "subscribe") return socket.close(1003, "invalid message");
    const requestedSceneId = (value as { sceneId?: unknown }).sceneId;
    let sceneId: string | null = null;
    if (requestedSceneId !== undefined && requestedSceneId !== null) {
      try { sceneId = validateId(requestedSceneId, "scene"); }
      catch { return socket.close(1003, "invalid scene id"); }
    }
    socket.serializeAttachment({ sceneId });
    socket.send(JSON.stringify({ type: "subscribed", sceneId }));
  }

  webSocketClose(socket: SocketWithAttachment) {
    try { socket.close(1000, "connection closed"); } catch {}
  }

  private send(socket: SocketWithAttachment, message: string) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_BACKPRESSURE_BYTES) {
      socket.close(1013, "backpressure limit exceeded");
      return;
    }
    try { socket.send(message); } catch { try { socket.close(1011, "broadcast failed"); } catch {} }
  }
}

export const REALTIME_ROUTE = REALTIME_PATH;
