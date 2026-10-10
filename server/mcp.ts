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

const MCP_SERVER_INSTRUCTIONS = [
  "Excalidraw 白板支持搜索、读取及批量绘制。普通绘图优先 create_board 一次传入名称和全部 elements，不要先建空板再逐个绘制。",
  "每次最多 1,000 个图元描述，只有超过数量或请求体限制时才分批；形状的 text 自动生成绑定文字，不需要另建文字。坐标为画布坐标，x/y 是左上角，箭头和直线使用 startX/startY/endX/endY。",
  "修改已有画板优先 update_board，一次合并删除、添加及改名；局部修改可省略 expectedRevision，服务端读取最新版本并用乐观锁保存。基于已读内容修改时传 expectedRevision，冲突后重新读取并重新判断，不要盲目重试。",
  "get_board 默认返回紧凑图元；view=summary 只读元数据，elementIds 可限定图元，view=full 才返回完整内部字段。list_boards 用 query 搜索，使用 nextCursor 分页。",
  "完整机器结果位于 structuredContent，content 只给简短说明；客户端应透传 structuredContent，并检查 ok 与 error.code。写操作只返回修订号、数量、生成的 ID 和画板 URL，无需为了确认成功再读取整个画板。",
  "不支持图片上传、自由绘制或直接输入原始 Excalidraw JSON；工具接受矩形、椭圆、菱形、文字、直线和箭头。输入必须为 JSON 对象，多行字符串遵循 JSON 转义规则。",
].join(" ");

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

const result = (value: Record<string, unknown>) => ({
  structuredContent: { ok: !value.error, ...value },
  content: [{ type: "text" as const, text: value.error
    ? `操作失败：${(value.error as { message: string }).message}`
    : "操作成功；详情见 structuredContent。" }],
});

const safeTool = <T>(handler: (args: T) => Promise<ReturnType<typeof result>>) =>
  async (args: T) => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof HttpError) {
        return result({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  };

const expectedRevisionSchema = z.number().int().positive().optional()
  .describe("可选的读取时修订号；省略时读取最新版本，仍使用乐观锁保存");

const assertRevision = (current: SceneData, expectedRevision?: number) => {
  if (expectedRevision !== undefined && expectedRevision !== current.revision) {
    throw new HttpError(409, "REVISION_CONFLICT", `画板已更新，当前修订号为 ${current.revision}；请重新读取后判断修改。`);
  }
};

const compactElement = (element: ExcalidrawElement) => {
  const fields = element as unknown as Record<string, unknown>;
  return Object.fromEntries([
    "id", "type", "x", "y", "width", "height", "angle", "text", "fontSize",
    "strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle",
    "roughness", "opacity", "points", "containerId", "boundElements", "startBinding", "endBinding",
  ].filter((key) => fields[key] !== undefined).map((key) => [key, fields[key]]));
};

const getPathToken = (req: Request) => {
  const pathname = new URL(req.url).pathname;
  const prefix = `${MCP_PATH}/`;
  if (!pathname.startsWith(prefix)) {
    return "";
  }
  const encodedToken = pathname.slice(prefix.length);
  if (!encodedToken || encodedToken.includes("/")) {
    return "";
  }
  try {
    return decodeURIComponent(encodedToken);
  } catch {
    return "";
  }
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
          { maxToolInputElements: 100_000, instructions: MCP_SERVER_INSTRUCTIONS },
        );
        const boardUrl = (id: string) => {
          const origin = requestInfo ? new URL(requestInfo.url).origin : "";
          return `${origin}/?id=${encodeURIComponent(id)}`;
        };

        server.registerTool(
          "list_boards",
          {
            title: "列出画板",
            description: "搜索并列出画板摘要（名称、ID、修订号、图元数量）；不回传正文。query 搜索名称/标签/文件夹，cursor 接续 nextCursor。",
            inputSchema: z.object({
              query: z.string().max(120).optional(),
              limit: z.number().int().min(1).max(100).optional(),
              cursor: z.string().max(2_000).optional(),
            }).strict(),
            annotations: {
              readOnlyHint: true,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          safeTool(async ({ query, limit, cursor }) => {
            const params = new URLSearchParams({
              limit: String(limit || 50),
            });
            if (query?.trim()) params.set("q", query.trim());
            if (cursor) params.set("cursor", cursor);
            const boards = await api<Record<string, unknown>>(
              `/api/scenes?${params.toString()}`,
              "GET",
            );
            return result(boards);
          }),
        );

        server.registerTool(
          "get_board",
          {
            title: "读取画板",
            description: "读取画板及修订号。默认紧凑图元；summary 只返回元数据，full 返回原始内部字段。elementIds 可只读取待修改图元。",
            inputSchema: z.object({
              boardId: z.string().min(1).max(128),
              view: z.enum(["summary", "elements", "full"]).optional(),
              elementIds: z.array(z.string().min(1).max(128)).min(1).max(1_000).optional(),
            }).strict(),
            annotations: {
              readOnlyHint: true,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          safeTool(async ({ boardId, view = "elements", elementIds }) => {
            if (view === "summary") {
              if (elementIds) throw new HttpError(400, "INVALID_ARGUMENT", "summary 不读取图元，请省略 elementIds。");
              const summary = await api<Record<string, unknown>>(`/api/scenes/${encodeURIComponent(boardId)}/summary`, "GET");
              return result({ ...summary, url: boardUrl(boardId) });
            }
            const board = await api<SceneData>(
              `/api/scenes/${encodeURIComponent(boardId)}`,
              "GET",
            );
            const selected = elementIds ? new Set(elementIds) : null;
            const elements = board.elements.filter((element) => !selected || selected.has(element.id));
            return result(view === "full"
              ? { ...board, elements, elementCount: board.elements.length, url: boardUrl(board.id) }
              : { id: board.id, name: board.name, revision: board.revision, elementCount: board.elements.length,
                elements: elements.map(compactElement), url: boardUrl(board.id),
                ...(selected ? { notFoundIds: elementIds!.filter((id) => !elements.some((element) => element.id === id)) } : {}) });
          }),
        );

        server.registerTool(
          "create_board",
          {
            title: "创建画板",
            description: "一次创建画板并绘制全部内容。普通绘图直接传完整 elements，最多 1,000 个描述；省略 elements 创建空板。允许同名，不会覆盖已有画板。",
            inputSchema: z.object({
              name: z.string().trim().min(1).max(120),
              elements: z.array(drawingElementSchema).max(1_000).optional(),
              backgroundColor: colorSchema.optional().describe("画布背景颜色，默认白色"),
            }).strict(),
            annotations: {
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false,
            },
          },
          safeTool(async ({ name, elements = [], backgroundColor }) => {
            const created = syncInvalidIndices(elements.flatMap(createDrawingElements));
            const board = await api<{ id: string; name: string; revision: number }>(
              "/api/scenes",
              "POST",
              { name, elements: created, appState: { viewBackgroundColor: backgroundColor || "#ffffff" } },
            );
            return result({ ...board, addedCount: created.length, elementIds: created.map((element) => element.id), url: boardUrl(board.id) });
          }),
        );

        server.registerTool(
          "add_elements",
          {
            title: "向画板绘制图元",
            description:
              "一次追加最多 1,000 个描述，不要逐个调用。矩形/椭圆/菱形的 text 自动绑定居中文字。混合删除、添加和改名优先 update_board。",
            inputSchema: z.object({
              boardId: z.string().min(1).max(128),
              elements: z.array(drawingElementSchema).min(1).max(1_000),
              expectedRevision: expectedRevisionSchema,
            }).strict(),
            annotations: {
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false,
            },
          },
          safeTool(async ({ boardId, elements, expectedRevision }) => {
            const current = await api<SceneData>(
              `/api/scenes/${encodeURIComponent(boardId)}`,
              "GET",
            );
            assertRevision(current, expectedRevision);
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
          }),
        );

        server.registerTool(
          "remove_elements",
          {
            title: "从画板移除图元",
            description: "按图元 ID 永久移除指定画板中的图元。",
            inputSchema: z.object({
              boardId: z.string().min(1).max(128),
              elementIds: z.array(z.string().min(1).max(128)).min(1).max(1_000),
              expectedRevision: expectedRevisionSchema,
            }).strict(),
            annotations: {
              destructiveHint: true,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          safeTool(async ({ boardId, elementIds, expectedRevision }) => {
            const current = await api<SceneData>(
              `/api/scenes/${encodeURIComponent(boardId)}`,
              "GET",
            );
            assertRevision(current, expectedRevision);
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
          }),
        );

        server.registerTool(
          "update_board",
          {
            title: "批量修改画板",
            description: "一次合并删除图元、添加图元、改名和背景修改，原子保存一个修订。替换局部图形时同时传 removeElementIds 与 elements；删除容器自动删除绑定文字并清理引用。不会覆盖其余图元。",
            inputSchema: z.object({
              boardId: z.string().min(1).max(128),
              expectedRevision: expectedRevisionSchema,
              elements: z.array(drawingElementSchema).min(1).max(1_000).optional(),
              removeElementIds: z.array(z.string().min(1).max(128)).min(1).max(1_000).optional(),
              name: z.string().trim().min(1).max(120).optional(),
              backgroundColor: colorSchema.optional(),
            }).strict(),
            annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
          },
          safeTool(async ({ boardId, expectedRevision, elements, removeElementIds, name, backgroundColor }) => {
            if (!elements && !removeElementIds && name === undefined && backgroundColor === undefined) {
              throw new HttpError(400, "EMPTY_UPDATE", "请提供 elements、removeElementIds、name 或 backgroundColor 中的至少一项。");
            }
            const current = await api<SceneData>(`/api/scenes/${encodeURIComponent(boardId)}`, "GET");
            assertRevision(current, expectedRevision);
            const remaining = removeDrawingElements(current.elements, removeElementIds || []);
            const created = (elements || []).flatMap(createDrawingElements);
            const saved = await api<{ revision: number }>(`/api/scenes/${encodeURIComponent(boardId)}`, "PUT", {
              baseRevision: current.revision,
              ...(name === undefined ? {} : { name }),
              elements: syncInvalidIndices([...remaining.elements, ...created]),
              appState: { ...current.appState, ...(backgroundColor === undefined ? {} : { viewBackgroundColor: backgroundColor }) },
            });
            return result({ boardId, revision: saved.revision, addedCount: created.length, removedCount: remaining.removedCount,
              elementIds: created.map((element) => element.id), url: boardUrl(boardId) });
          }),
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
            "Accept, Content-Type, Last-Event-Id, Mcp-Method, Mcp-Name, Mcp-Protocol-Version, Mcp-Session-Id",
          "Access-Control-Max-Age": "600",
        });
        const origin = req.headers.get("origin");
        if (origin && runtime.config.corsOrigins.has(origin)) {
          headers.set("Access-Control-Allow-Origin", origin);
          headers.set("Vary", "Origin");
        }
        return response(runtime, req, null, { status: 204, headers });
      }

      const providedToken = new TextEncoder().encode(getPathToken(req));
      const tokenBytes = new TextEncoder().encode(expectedToken);
      if (!timingSafeEqual(providedToken, tokenBytes)) {
        return jsonResponse(
          runtime,
          req,
          { error: "MCP URL 令牌无效或缺失", code: "MCP_UNAUTHORIZED" },
          401,
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
