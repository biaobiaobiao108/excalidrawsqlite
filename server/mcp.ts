import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { DEFAULT_ELEMENT_PROPS } from "@excalidraw/common";
import { pointFrom } from "@excalidraw/math";
import type { LocalPoint } from "@excalidraw/math";
import {
  newArrowElement,
  newElement,
  newLinearElement,
  newTextElement,
} from "@excalidraw/element/newElement";
import { syncInvalidIndices } from "@excalidraw/element/fractionalIndex";
import { newElementWith } from "@excalidraw/element/mutateElement";
import { setCustomTextMetricsProvider } from "@excalidraw/element/textMeasurements";

import { randomBase64Url, timingSafeEqual } from "./crypto";
import { HttpError } from "./errors";
import { isAllowedOrigin, jsonResponse, response } from "./http";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ServerRuntime } from "./types";

export const MCP_PATH = "/mcp";

type ApiHandler = (req: Request) => Promise<Response>;
type McpRequestHandler = {
  fetch: (req: Request) => Promise<Response>;
  close: () => Promise<void>;
};

type SceneData = {
  id: string;
  name: string;
  elements: ExcalidrawElement[];
  appState: Record<string, unknown>;
  revision: number;
};

const coordinateSchema = z.number().finite().min(-1_000_000).max(1_000_000);
const dimensionSchema = z.number().finite().positive().max(1_000_000);
const colorSchema = z.string().max(64);
const styleSchema = {
  strokeColor: colorSchema.optional(),
  backgroundColor: colorSchema.optional(),
  fillStyle: z.enum(["hachure", "cross-hatch", "solid", "zigzag"]).optional(),
  strokeWidth: z.number().finite().min(0.5).max(100).optional(),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  roughness: z.number().finite().min(0).max(2).optional(),
  opacity: z.number().int().min(0).max(100).optional(),
};

const drawingElementSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rectangle"),
    x: coordinateSchema,
    y: coordinateSchema,
    width: dimensionSchema,
    height: dimensionSchema,
    text: z.string().max(2_000).optional(),
    ...styleSchema,
  }),
  z.object({
    type: z.literal("ellipse"),
    x: coordinateSchema,
    y: coordinateSchema,
    width: dimensionSchema,
    height: dimensionSchema,
    text: z.string().max(2_000).optional(),
    ...styleSchema,
  }),
  z.object({
    type: z.literal("diamond"),
    x: coordinateSchema,
    y: coordinateSchema,
    width: dimensionSchema,
    height: dimensionSchema,
    text: z.string().max(2_000).optional(),
    ...styleSchema,
  }),
  z.object({
    type: z.literal("text"),
    x: coordinateSchema,
    y: coordinateSchema,
    text: z.string().min(1).max(10_000),
    fontSize: z.number().finite().min(1).max(512).optional(),
    ...styleSchema,
  }),
  z.object({
    type: z.literal("line"),
    startX: coordinateSchema,
    startY: coordinateSchema,
    endX: coordinateSchema,
    endY: coordinateSchema,
    ...styleSchema,
  }).refine((element) => element.startX !== element.endX || element.startY !== element.endY),
  z.object({
    type: z.literal("arrow"),
    startX: coordinateSchema,
    startY: coordinateSchema,
    endX: coordinateSchema,
    endY: coordinateSchema,
    ...styleSchema,
  }).refine((element) => element.startX !== element.endX || element.startY !== element.endY),
]);

type DrawingElementSpec = z.infer<typeof drawingElementSchema>;

// The server cannot measure text with a browser canvas. This provider keeps
// generated text geometry deterministic while approximating CJK glyph widths.
setCustomTextMetricsProvider({
  getLineWidth(text, fontString) {
    const fontSize = Number.parseFloat(fontString) || 20;
    let width = 0;
    for (const character of text) {
      width += /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/u.test(
        character,
      )
        ? fontSize
        : fontSize * 0.58;
    }
    return width;
  },
});

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const getBearerToken = (req: Request) => {
  const header = req.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] || "";
};

const createInternalApi = (apiHandler: ApiHandler, sessionToken: string) =>
  async <T>(path: string, method: "GET" | "POST" | "PUT", body?: unknown) => {
    const req = new Request(`http://excalidraw-mcp.internal${path}`, {
      method,
      headers: {
        Cookie: `excalidraw_session=${sessionToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const res = await apiHandler(req);
    const responseBody = await res.text();
    let parsed: unknown;
    try {
      parsed = responseBody ? JSON.parse(responseBody) : null;
    } catch {
      parsed = responseBody;
    }
    if (!res.ok) {
      const error = parsed as { code?: string; error?: string } | null;
      throw new HttpError(
        res.status,
        error?.code || "MCP_API_ERROR",
        error?.error || `内部画板 API 请求失败（HTTP ${res.status}）`,
      );
    }
    return parsed as T;
  };

const elementStyle = (element: DrawingElementSpec) => ({
  strokeColor: element.strokeColor || DEFAULT_ELEMENT_PROPS.strokeColor,
  backgroundColor:
    element.backgroundColor || DEFAULT_ELEMENT_PROPS.backgroundColor,
  fillStyle: element.fillStyle || DEFAULT_ELEMENT_PROPS.fillStyle,
  strokeWidth: element.strokeWidth ?? DEFAULT_ELEMENT_PROPS.strokeWidth,
  strokeStyle: element.strokeStyle || DEFAULT_ELEMENT_PROPS.strokeStyle,
  roughness: element.roughness ?? DEFAULT_ELEMENT_PROPS.roughness,
  opacity: element.opacity ?? DEFAULT_ELEMENT_PROPS.opacity,
});

const createDrawingElements = (spec: DrawingElementSpec): ExcalidrawElement[] => {
  const style = elementStyle(spec);
  switch (spec.type) {
    case "rectangle":
    case "ellipse":
    case "diamond": {
      const shape = newElement({
        type: spec.type,
        x: spec.x,
        y: spec.y,
        width: spec.width,
        height: spec.height,
        ...style,
      });
      if (!spec.text) {
        return [shape];
      }
      const label = newTextElement({
        x: spec.x + spec.width / 2,
        y: spec.y + spec.height / 2,
        text: spec.text,
        fontSize: 20,
        textAlign: "center",
        verticalAlign: "middle",
        containerId: shape.id,
        ...style,
      });
      return [
        {
          ...shape,
          boundElements: [{ type: "text", id: label.id }],
        } as ExcalidrawElement,
        label,
      ];
    }
    case "text":
      return [
        newTextElement({
          x: spec.x,
          y: spec.y,
          text: spec.text,
          fontSize: spec.fontSize,
          ...style,
        }),
      ];
    case "line":
    case "arrow": {
      const x = Math.min(spec.startX, spec.endX);
      const y = Math.min(spec.startY, spec.endY);
      const points = [
        pointFrom<LocalPoint>(spec.startX - x, spec.startY - y),
        pointFrom<LocalPoint>(spec.endX - x, spec.endY - y),
      ];
      const opts = {
        x,
        y,
        width: Math.abs(spec.endX - spec.startX),
        height: Math.abs(spec.endY - spec.startY),
        points,
        ...style,
      };
      if (spec.type === "line") {
        return [newLinearElement({ type: "line", ...opts })];
      }
      return [
        newArrowElement({
          type: "arrow",
          endArrowhead: "arrow",
          ...opts,
        }),
      ];
    }
  }
};

const removeDrawingElements = (
  current: readonly ExcalidrawElement[],
  requestedIds: readonly string[],
) => {
  const idsToRemove = new Set(requestedIds);
  for (const element of current) {
    if (!idsToRemove.has(element.id)) {
      continue;
    }
    const fields = element as ExcalidrawElement & {
      boundElements?: Array<{ id: string; type: string }> | null;
    };
    for (const bound of fields.boundElements || []) {
      if (bound.type === "text") {
        idsToRemove.add(bound.id);
      }
    }
    for (const child of current) {
      const childFields = child as ExcalidrawElement & {
        containerId?: string | null;
      };
      if (childFields.containerId === element.id) {
        idsToRemove.add(child.id);
      }
    }
  }

  const remaining = current.filter((element) => !idsToRemove.has(element.id));
  const remainingIds = new Set(remaining.map((element) => element.id));
  const cleaned = remaining.map((element) => {
    const fields = element as ExcalidrawElement & {
      boundElements?: Array<{ id: string; type: string }> | null;
      containerId?: string | null;
      startBinding?: { elementId: string } | null;
      endBinding?: { elementId: string } | null;
    };
    const updates: Record<string, unknown> = {};
    if (Array.isArray(fields.boundElements)) {
      const boundElements = fields.boundElements.filter((bound) =>
        remainingIds.has(bound.id),
      );
      if (boundElements.length !== fields.boundElements.length) {
        updates.boundElements = boundElements.length ? boundElements : null;
      }
    }
    for (const bindingKey of ["startBinding", "endBinding"] as const) {
      const binding = fields[bindingKey];
      if (binding && !remainingIds.has(binding.elementId)) {
        updates[bindingKey] = null;
      }
    }
    if (fields.containerId && !remainingIds.has(fields.containerId)) {
      updates.containerId = null;
    }
    return Object.keys(updates).length
      ? newElementWith(element, updates as never)
      : element;
  });

  return {
    elements: cleaned,
    removedCount: current.length - remaining.length,
  };
};

export const createMcpRequestHandler = (
  runtime: ServerRuntime,
  apiHandler: ApiHandler,
): McpRequestHandler => {
  const expectedToken = runtime.config.mcpToken;
  const internalSessionToken = expectedToken ? randomBase64Url(32) : null;
  if (internalSessionToken) {
    // MCP calls pass through the exact same route validation and persistence
    // logic as the browser, using a private in-memory session never exposed to
    // network requests or persisted to SQLite.
    runtime.sessions.set(internalSessionToken, Number.MAX_SAFE_INTEGER);
  }

  const api = internalSessionToken
    ? createInternalApi(apiHandler, internalSessionToken)
    : null;

  const mcp = expectedToken && api
    ? createMcpHandler(({ requestInfo }) => {
        const server = new McpServer(
          { name: "excalidrawsqlite", version: "1.0.0" },
          { maxToolInputElements: 10_000 },
        );
        const boardUrl = (id: string) => {
          const origin = requestInfo ? new URL(requestInfo.url).origin : "";
          return `${origin}/?id=${encodeURIComponent(id)}`;
        };

        server.registerTool(
          "list_boards",
          {
            title: "列出画板",
            description: "搜索并列出当前工作区的画板。",
            inputSchema: z.object({
              query: z.string().max(120).optional(),
              limit: z.number().int().min(1).max(100).optional(),
              cursor: z.string().max(2_000).optional(),
            }),
            annotations: {
              readOnlyHint: true,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          async ({ query, limit, cursor }) => {
            const params = new URLSearchParams({
              limit: String(limit || 50),
            });
            if (query?.trim()) params.set("q", query.trim());
            if (cursor) params.set("cursor", cursor);
            const boards = await api<unknown>(
              `/api/scenes?${params.toString()}`,
              "GET",
            );
            return result(boards);
          },
        );

        server.registerTool(
          "get_board",
          {
            title: "读取画板",
            description: "读取画板完整内容，包括图元、名称和修订号。",
            inputSchema: z.object({ boardId: z.string().min(1).max(128) }),
            annotations: {
              readOnlyHint: true,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          async ({ boardId }) => {
            const board = await api<SceneData>(
              `/api/scenes/${encodeURIComponent(boardId)}`,
              "GET",
            );
            return result({ ...board, url: boardUrl(board.id) });
          },
        );

        server.registerTool(
          "create_board",
          {
            title: "创建画板",
            description: "新建一个空白 Excalidraw 画板。",
            inputSchema: z.object({ name: z.string().trim().min(1).max(120) }),
            annotations: {
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false,
            },
          },
          async ({ name }) => {
            const board = await api<{ id: string; name: string; revision: number }>(
              "/api/scenes",
              "POST",
              { name },
            );
            return result({ ...board, url: boardUrl(board.id) });
          },
        );

        server.registerTool(
          "add_elements",
          {
            title: "向画板绘制图元",
            description:
              "向指定画板添加矩形、椭圆、菱形、文字、直线或箭头。坐标为 Excalidraw 画布坐标；矩形可通过 text 添加居中文字。",
            inputSchema: z.object({
              boardId: z.string().min(1).max(128),
              elements: z.array(drawingElementSchema).min(1).max(300),
            }),
            annotations: {
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false,
            },
          },
          async ({ boardId, elements }) => {
            const current = await api<SceneData>(
              `/api/scenes/${encodeURIComponent(boardId)}`,
              "GET",
            );
            const created = elements.flatMap(createDrawingElements);
            const merged = syncInvalidIndices([
              ...current.elements,
              ...created,
            ]);
            const saved = await api<{ revision: number; updated_at: number }>(
              `/api/scenes/${encodeURIComponent(boardId)}`,
              "PUT",
              {
                baseRevision: current.revision,
                elements: merged,
                appState: current.appState || {},
              },
            );
            return result({
              boardId,
              addedCount: created.length,
              elementIds: created.map((element) => element.id),
              revision: saved.revision,
              url: boardUrl(boardId),
            });
          },
        );

        server.registerTool(
          "remove_elements",
          {
            title: "从画板移除图元",
            description: "按图元 ID 永久移除指定画板中的图元。",
            inputSchema: z.object({
              boardId: z.string().min(1).max(128),
              elementIds: z.array(z.string().min(1).max(128)).min(1).max(300),
            }),
            annotations: {
              destructiveHint: true,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          async ({ boardId, elementIds }) => {
            const current = await api<SceneData>(
              `/api/scenes/${encodeURIComponent(boardId)}`,
              "GET",
            );
            const { elements, removedCount } = removeDrawingElements(
              current.elements,
              elementIds,
            );
            if (!removedCount) {
              return result({ boardId, removedCount: 0, revision: current.revision });
            }
            const saved = await api<{ revision: number }>(
              `/api/scenes/${encodeURIComponent(boardId)}`,
              "PUT",
              {
                baseRevision: current.revision,
                elements,
                appState: current.appState || {},
              },
            );
            return result({ boardId, removedCount, revision: saved.revision });
          },
        );

        return server;
      }, {
        maxRequestBodySize: runtime.config.maxSceneBodyBytes,
        onerror(error) {
          console.info("[MCP] 请求处理失败", error);
        },
      })
    : null;

  return {
    fetch: async (req) => {
      if (!expectedToken || !mcp) {
        return jsonResponse(
          runtime,
          req,
          { error: "MCP 尚未启用，请设置 MCP_TOKEN", code: "MCP_DISABLED" },
          404,
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

      if (req.method === "OPTIONS") {
        const headers = new Headers({
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers":
            "Accept, Authorization, Content-Type, Last-Event-Id, Mcp-Method, Mcp-Name, Mcp-Protocol-Version, Mcp-Session-Id",
          "Access-Control-Max-Age": "600",
        });
        const origin = req.headers.get("origin");
        if (origin && runtime.config.corsOrigins.has(origin)) {
          headers.set("Access-Control-Allow-Origin", origin);
          headers.set("Vary", "Origin");
        }
        return response(runtime, req, null, { status: 204, headers });
      }

      const providedToken = new TextEncoder().encode(getBearerToken(req));
      const tokenBytes = new TextEncoder().encode(expectedToken);
      if (!timingSafeEqual(providedToken, tokenBytes)) {
        return jsonResponse(
          runtime,
          req,
          { error: "MCP 访问令牌无效", code: "MCP_UNAUTHORIZED" },
          401,
          { "WWW-Authenticate": "Bearer" },
        );
      }

      const mcpResponse = await mcp.fetch(req, {
        authInfo: {
          token: expectedToken,
          clientId: "excalidrawsqlite-mcp-client",
          scopes: ["boards:read", "boards:write"],
          expiresAt: Number.MAX_SAFE_INTEGER,
        },
      });
      return response(runtime, req, mcpResponse.body, {
        status: mcpResponse.status,
        statusText: mcpResponse.statusText,
        headers: mcpResponse.headers,
      });
    },
    close: async () => {
      if (internalSessionToken) {
        runtime.sessions.delete(internalSessionToken);
      }
      await mcp?.close();
    },
  };
};
