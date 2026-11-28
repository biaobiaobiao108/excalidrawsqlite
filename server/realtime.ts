import { getSessionExpiration, getSessionToken } from "./auth";
import { HttpError } from "./errors";
import { isAllowedOrigin, jsonResponse } from "./http";
import { validateId } from "./validation";

import type {
  RealtimePublisher,
  SceneRealtimeEvent,
  ServerRuntime,
  WorkspaceRealtimeEvent,
} from "./types";

export const REALTIME_PATH = "/api/realtime";
const WORKSPACE_TOPIC = "workspace";
const SCENE_TOPIC_PREFIX = "scene:";
const MAX_CLIENT_MESSAGE_BYTES = 8 * 1024;

export type RealtimeSocketData = {
  sceneId: string | null;
  token?: string;
  expiresAt?: number;
};

const sceneTopic = (sceneId: string) => `${SCENE_TOPIC_PREFIX}${sceneId}`;

const serializeEvent = (event: SceneRealtimeEvent | WorkspaceRealtimeEvent) =>
  JSON.stringify(event);

const parseClientMessage = (message: string | Buffer) => {
  if (Buffer.byteLength(message) > MAX_CLIENT_MESSAGE_BYTES) {
    throw new HttpError(1009, "MESSAGE_TOO_LARGE", "WebSocket 消息过大");
  }
  let value: unknown;
  try {
    value = JSON.parse(message.toString());
  } catch {
    throw new HttpError(1003, "INVALID_MESSAGE", "WebSocket 消息格式无效");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { type?: unknown }).type !== "subscribe"
  ) {
    throw new HttpError(1003, "INVALID_MESSAGE", "WebSocket 消息类型无效");
  }
  const requestedSceneId = (value as { sceneId?: unknown }).sceneId;
  if (requestedSceneId === undefined || requestedSceneId === null) {
    return null;
  }
  return validateId(requestedSceneId, "scene");
};

const realtimeQueryCache = new WeakMap<
  ServerRuntime,
  {
    getSceneMeta: ReturnType<ServerRuntime["db"]["query"]>;
  }
>();

const getRealtimeStatements = (runtime: ServerRuntime) => {
  let cached = realtimeQueryCache.get(runtime);
  if (!cached) {
    cached = {
      getSceneMeta: runtime.db.query(
        "SELECT revision, updated_at, deleted_at FROM scenes WHERE id = ?",
      ),
    };
    realtimeQueryCache.set(runtime, cached);
  }
  return cached;
};

export const createRealtimeHub = (runtime: ServerRuntime) => {
  let server: Bun.Server<RealtimeSocketData> | null = null;

  const publish = (
    topic: string,
    event: SceneRealtimeEvent | WorkspaceRealtimeEvent,
  ) => {
    if (!server) {
      return;
    }
    if (scheduledExpiration <= Date.now()) expireSessions();
    const status = server.publish(topic, serializeEvent(event));
    if (status < 0) {
      console.info("[Realtime] WebSocket backpressure applied", { topic });
    }
  };

  const publisher: RealtimePublisher = {
    publishSceneChanged: (event) => {
      publish(sceneTopic(event.sceneId), event);
      publish(WORKSPACE_TOPIC, {
        type: "workspace_changed",
        updatedAt: event.updatedAt,
        sceneId: event.sceneId,
        revision: event.revision,
        changeKind: event.changeKind,
        metadataChanged: event.metadataChanged,
      });
    },
    publishWorkspaceChanged: (updatedAt = Date.now(), changeKind) => {
      publish(WORKSPACE_TOPIC, {
        type: "workspace_changed",
        updatedAt,
        changeKind,
      });
    },
    revokeSession: (token) => {
      for (const ws of activeSockets) {
        if (ws.data.token === token) disconnectSession(ws);
      }
    },
  };

  const activeSockets = new Set<Bun.ServerWebSocket<RealtimeSocketData>>();
  let expirationTimer: ReturnType<typeof setTimeout> | undefined;
  let scheduledExpiration = Infinity;

  const disconnectSession = (ws: Bun.ServerWebSocket<RealtimeSocketData>) => {
    activeSockets.delete(ws);
    ws.unsubscribe(WORKSPACE_TOPIC);
    if (ws.data.sceneId) ws.unsubscribe(sceneTopic(ws.data.sceneId));
    ws.close(1008, "Session expired or revoked");
  };

  const expireSessions = () => {
    clearTimeout(expirationTimer);
    scheduledExpiration = Infinity;
    expirationTimer = undefined;
    const now = Date.now();
    let next = Infinity;
    for (const ws of activeSockets) {
      if (ws.data.expiresAt === undefined) continue;
      if (ws.data.expiresAt <= now) disconnectSession(ws);
      else next = Math.min(next, ws.data.expiresAt);
    }
    watchExpiration(next);
  };

  const watchExpiration = (expiresAt: number) => {
    if (expiresAt >= scheduledExpiration) return;
    clearTimeout(expirationTimer);
    scheduledExpiration = expiresAt;
    expirationTimer = setTimeout(
      expireSessions,
      Math.min(2_147_483_647, Math.max(0, expiresAt - Date.now())),
    );
    expirationTimer.unref?.();
  };

  const websocket: Bun.WebSocketHandler<RealtimeSocketData> = {
    data: {} as RealtimeSocketData,
    maxPayloadLength: MAX_CLIENT_MESSAGE_BYTES,
    backpressureLimit: 256 * 1024,
    closeOnBackpressureLimit: true,
    idleTimeout: 120,
    sendPings: true,
    open: (ws) => {
      if (ws.data.expiresAt !== undefined) {
        if (ws.data.expiresAt <= Date.now()) {
          disconnectSession(ws);
          return;
        }
        watchExpiration(ws.data.expiresAt);
      }
      activeSockets.add(ws);
      ws.subscribe(WORKSPACE_TOPIC);
      if (ws.data.sceneId) {
        ws.subscribe(sceneTopic(ws.data.sceneId));
        const row = getRealtimeStatements(runtime).getSceneMeta.get(
          ws.data.sceneId,
        ) as {
          revision: number;
          updated_at: number;
          deleted_at: number | null;
        } | null;
        ws.sendText(
          serializeEvent({
            type: "scene_changed",
            sceneId: ws.data.sceneId,
            revision: Number(row?.revision) || 0,
            updatedAt: Number(row?.updated_at) || Date.now(),
            changeKind: !row || row.deleted_at ? "deleted" : "content",
          }),
        );
      } else {
        ws.sendText(
          serializeEvent({
            type: "workspace_changed",
            updatedAt: Date.now(),
          }),
        );
      }
      ws.sendText(
        JSON.stringify({
          type: "ready",
          sceneId: ws.data.sceneId,
        }),
      );
    },
    close: (ws) => {
      activeSockets.delete(ws);
      if (!activeSockets.size) {
        clearTimeout(expirationTimer);
        expirationTimer = undefined;
        scheduledExpiration = Infinity;
      }
    },
    message: (ws, message) => {
      if (!activeSockets.has(ws)) return;
      if (ws.data.expiresAt !== undefined && ws.data.expiresAt <= Date.now()) {
        disconnectSession(ws);
        return;
      }
      try {
        const nextSceneId = parseClientMessage(message);
        const previousSceneId = ws.data.sceneId;
        if (previousSceneId) {
          ws.unsubscribe(sceneTopic(previousSceneId));
        }
        ws.data.sceneId = nextSceneId;
        if (nextSceneId) {
          ws.subscribe(sceneTopic(nextSceneId));
        }
        ws.sendText(
          JSON.stringify({
            type: "subscribed",
            sceneId: nextSceneId,
          }),
        );
      } catch (error) {
        if (error instanceof HttpError && error.status >= 1000) {
          ws.close(error.status, error.message);
          return;
        }
        ws.close(1003, "invalid message");
      }
    },
  };

  return {
    publisher,
    websocket,
    closeSockets: () => {
      clearTimeout(expirationTimer);
      expirationTimer = undefined;
      scheduledExpiration = Infinity;
      for (const ws of activeSockets) {
        try {
          ws.close(1001, "Server shutting down");
        } catch {
          // Socket might already be closed.
        }
      }
      activeSockets.clear();
    },
    attachServer: (nextServer: Bun.Server<RealtimeSocketData>) => {
      server = nextServer;
    },
    upgrade: (
      req: Request,
      nextServer: Bun.Server<RealtimeSocketData>,
    ): Response | undefined => {
      if (req.method !== "GET") {
        return jsonResponse(
          runtime,
          req,
          { error: "WebSocket 只支持 GET", code: "METHOD_NOT_ALLOWED" },
          405,
          { Allow: "GET" },
        );
      }
      if (!isAllowedOrigin(runtime, req)) {
        return jsonResponse(
          runtime,
          req,
          { error: "不允许的跨域来源", code: "CORS_FORBIDDEN" },
          403,
        );
      }
      const requiresSession =
        !runtime.config.allowAnonymous && Boolean(runtime.config.authPassword);
      const token = requiresSession ? getSessionToken(runtime, req) : undefined;
      let expiresAt: number | undefined;
      if (requiresSession) {
        expiresAt = token
          ? (getSessionExpiration(runtime, token) ?? undefined)
          : undefined;
        if (expiresAt === undefined) {
          return jsonResponse(
            runtime,
            req,
            { error: "请先完成访问授权", code: "AUTH_REQUIRED" },
            401,
          );
        }
      }
      const url = new URL(req.url);
      let sceneId: string | null = null;
      const requestedSceneId = url.searchParams.get("scene_id");
      if (requestedSceneId) {
        try {
          sceneId = validateId(requestedSceneId, "scene");
        } catch {
          return jsonResponse(
            runtime,
            req,
            { error: "无效的资源 ID", code: "INVALID_ID" },
            400,
          );
        }
      }
      if (
        !nextServer.upgrade(req, {
          data: { sceneId, token, expiresAt },
        })
      ) {
        return jsonResponse(
          runtime,
          req,
          { error: "WebSocket 升级失败", code: "UPGRADE_FAILED" },
          400,
        );
      }
      return undefined;
    },
  };
};
