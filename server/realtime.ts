import { isAuthorized } from "./auth";
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
};

const sceneTopic = (sceneId: string) => `${SCENE_TOPIC_PREFIX}${sceneId}`;

const serializeEvent = (
  event: SceneRealtimeEvent | WorkspaceRealtimeEvent,
) => JSON.stringify(event);

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

export const createRealtimeHub = (runtime: ServerRuntime) => {
  let server: Bun.Server<RealtimeSocketData> | null = null;

  const publish = (
    topic: string,
    event: SceneRealtimeEvent | WorkspaceRealtimeEvent,
  ) => {
    if (!server) {
      return;
    }
    const status = server.publishText(topic, serializeEvent(event));
    if (status < 0) {
      console.warn("[Realtime] WebSocket backpressure applied", { topic });
    }
  };

  const publisher: RealtimePublisher = {
    publishSceneChanged: (event) => {
      publish(sceneTopic(event.sceneId), event);
      publish(WORKSPACE_TOPIC, event);
    },
    publishWorkspaceChanged: (updatedAt = Date.now()) => {
      publish(WORKSPACE_TOPIC, {
        type: "workspace_changed",
        updatedAt,
      });
    },
  };

  const websocket: Bun.WebSocketHandler<RealtimeSocketData> = {
    data: {} as RealtimeSocketData,
    maxPayloadLength: MAX_CLIENT_MESSAGE_BYTES,
    backpressureLimit: 256 * 1024,
    closeOnBackpressureLimit: true,
    idleTimeout: 120,
    sendPings: true,
    open: (ws) => {
      ws.subscribe(WORKSPACE_TOPIC);
      if (ws.data.sceneId) {
        ws.subscribe(sceneTopic(ws.data.sceneId));
      }
      ws.sendText(
        JSON.stringify({
          type: "ready",
          sceneId: ws.data.sceneId,
        }),
      );
    },
    message: (ws, message) => {
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
    error: (_ws, error) => {
      console.warn("[Realtime] WebSocket error", error);
    },
  };

  return {
    publisher,
    websocket,
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
      if (!isAuthorized(runtime, req)) {
        return jsonResponse(
          runtime,
          req,
          { error: "请先完成访问授权", code: "AUTH_REQUIRED" },
          401,
        );
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
          data: { sceneId },
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
    setServer: (nextServer: Bun.Server<RealtimeSocketData>) => {
      server = nextServer;
    },
  };
};
