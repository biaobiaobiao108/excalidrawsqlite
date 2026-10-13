import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  colorSchema, drawingElementSchema, createDrawingBatch, removeDrawingElements,
  compactElement, elementUpdateSchema, updateDrawingElements, inputDrawingElements,
} from "./mcp-drawing";
import { compactDrawingElements } from "./mcp-read";
import { registerManagementTools, resolveFolder } from "./mcp-management";
import { measureMcpApi, measureMcpPhase, traceMcpTool } from "./mcp-trace";
import { compactMcpSchema } from "./mcp-schema";
import { buildDiagram, diagramSchema } from "./mcp-diagram";

import { timingSafeEqual } from "./crypto";
import { HttpError } from "./errors";
import { getRequestOrigin, isAllowedOrigin, jsonResponse, response } from "./http";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ServerRuntime } from "./types";

export const MCP_PATH = "/mcp";

const MCP_SERVER_INSTRUCTIONS = [
  "Excalidraw 白板支持搜索、读取及批量绘制。流程图/时间线优先 create_diagram 一次传 nodes/edges 自动排版；自定义绘图用 create_board 一次传入名称和全部 elements，不要先建空板再逐个绘制。",
  "每次最多 1,000 个图元描述；形状 text 自动绑定文字。可给节点指定 id，箭头 startBinding/endBinding.elementId 引用同批或已有节点，拖动节点时保持连接。折线 points 使用绝对画布坐标；二点仍可用 startX/startY/endX/endY。字段严格校验，不能输入原始内部字段。",
  "修改优先 update_board 一次合并添加、removeElementIds、updates 原地修改及元数据；只改一个图元用 update_element，保留 ID 和绑定。expectedRevision 是可选的已读修订号，服务端始终使用乐观锁；冲突后重新判断，禁止盲目重试。",
  "get_board 的 input 视图用于跨板复制：elements 保留原 ID，可传给 create_board 或其他画板的 add_elements；同板原地修改用 update_element/update_board.updates，追加已有 ID 会报错。绑定文字合并到形状，points 是绝对坐标，rotation 是度。truncated/nextOffset 表示分页或预算截断；仅 input 的 unsupportedElementIds/warnings 表示不可写投影省略，图元被省略不能视为空板。默认紧凑视图用于阅读，full 为内部格式且 points 是相对坐标。",
  "create_board 可同时设置 folderId/folderName、favorite、tags；folderName 会幂等获取或创建文件夹，重名歧义报错。文件夹用 list/ensure/create/update/delete_folder。manage_board 一次管理收藏、标签、移动和改名，batch_manage_boards 批量管理逐条返回结果。",
  "delete_board 只软删除，restore_board 还原；MCP 不提供永久删除或清空回收站。回收站受服务端保留期限约束。delete_folder 仅移画板至根目录，正式执行需 confirm=true，可先 dryRun 查看影响。",
  "成功与业务结果位于 structuredContent，检查 ok 与 error.code；schema 拒绝可能只有 isError=true 和 text，客户端也必须读取该错误。画板标识统一 boardId，元数据使用 elementCount/folderId/folderName/createdAt/updatedAt/lastOpenedAt/deletedAt。图元和文件夹仍使用 id。绘图写工具默认 responseMode=minimal 仅回数量/修订号/URL；需要自动 ID 时设 ids 返回 elementMap（inputIndex 对应本体与 labelId）、requestedElementIds（本体）、generatedElementIds（附属文字）。addedCount 是本次 elements 新建的实际图元数，elementCount 是全板当前图元数。批读 partial 表示成功失败混合，truncated 仅表示内容/预算截断。",
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

const cleanBoardRecord = (value: Record<string, unknown>): Record<string, unknown> => {
  const { thumbnail_file_id: _thumbnail, size: _size, ...clean } = value;
  if (typeof value.id === "string" && typeof value.revision === "number") {
    clean.boardId = value.id;
    delete clean.id;
  }
  if (typeof clean.boardId === "string") {
    for (const [stored, exposed] of [
      ["element_count", "elementCount"], ["folder_id", "folderId"], ["folder_name", "folderName"],
      ["created_at", "createdAt"], ["updated_at", "updatedAt"], ["last_opened_at", "lastOpenedAt"],
      ["deleted_at", "deletedAt"],
    ]) {
      if (Object.hasOwn(clean, stored)) {
        clean[exposed] = clean[stored];
        delete clean[stored];
      }
    }
  }
  if (typeof clean.icon === "string" && typeof clean.id === "string") {
    for (const [stored, exposed] of [["scene_count", "boardCount"], ["created_at", "createdAt"], ["updated_at", "updatedAt"]]) {
      if (Object.hasOwn(clean, stored)) {
        clean[exposed] = clean[stored];
        delete clean[stored];
      }
    }
  }
  return clean;
};

const result = (value: Record<string, unknown>) => measureMcpPhase("responseBuildMs", () => ({
  structuredContent: { ok: !value.error, ...cleanBoardRecord(value),
    ...Object.fromEntries(["items", "boards", "results", "folders"].filter((key) => Array.isArray(value[key]))
      .map((key) => [key, (value[key] as Record<string, unknown>[]).map(cleanBoardRecord)])),
    ...(value.folder && typeof value.folder === "object"
      ? { folder: cleanBoardRecord(value.folder as Record<string, unknown>) } : {}),
  },
  content: [{ type: "text" as const, text: value.error
    ? `操作失败：${(value.error as { message: string }).message}`
    : "操作成功；详情见 structuredContent。" }],
}));

const responseModeSchema = z.enum(["minimal", "ids"]).optional()
  .describe("默认 minimal 仅返回修订号/数量/URL；ids 另含图元 ID 与 inputIndex 映射");

const drawingReceipt = (created: readonly ExcalidrawElement[], mode: "minimal" | "ids" = "minimal") => {
  if (mode === "minimal") return { addedCount: created.length };
  const ids = new Set(created.map((element) => element.id));
  const generated = created.filter((element) => element.type === "text" && element.containerId && ids.has(element.containerId));
  const generatedIds = new Set(generated.map((element) => element.id));
  const requested = created.filter((element) => !generatedIds.has(element.id));
  return {
    addedCount: created.length,
    requestedElementIds: requested.map((element) => element.id),
    generatedElementIds: generated.map((element) => element.id),
    elementMap: requested.map((element, inputIndex) => ({ inputIndex, elementId: element.id,
      ...(element.boundElements?.find((bound) => bound.type === "text")
        ? { labelId: element.boundElements.find((bound) => bound.type === "text")!.id } : {}),
    })),
  };
};

const makeSafeTool = <T>(handler: (args: T) => Promise<ReturnType<typeof result>>, trace = false, operation = "tool") =>
  async (args: T) => traceMcpTool(trace, operation, async () => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof HttpError) {
        return result({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });

const expectedRevisionSchema = z.number().int().positive().optional()
  .describe("可选的读取时修订号；省略时读取最新版本，仍使用乐观锁保存");

const boardMetadataSchema = {
  folderId: z.string().min(1).max(128).nullable().optional().describe("目标文件夹 ID；null 移至根目录，不可与 folderName 同传"),
  folderName: z.string().trim().min(1).max(80).optional().describe("按精确名称获取或创建文件夹；重名拒绝，不可与 folderId 同传"),
  tags: z.array(z.string().trim().min(1).max(32)).max(12).optional().describe("完整标签列表，空数组清除；增删标签可用 manage_board"),
  favorite: z.boolean().optional(),
};

const assertRevision = (current: SceneData, expectedRevision?: number) => {
  if (expectedRevision !== undefined && expectedRevision !== current.revision) {
    throw new HttpError(409, "REVISION_CONFLICT", `画板已更新，当前修订号为 ${current.revision}；请重新读取后判断修改。`);
  }
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

const createInternalApi = (apiHandler: ApiHandler, token: string) =>
  async <T>(path: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown) => measureMcpApi(method, async () => {
    const req = new Request(`http://excalidraw-mcp.internal${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
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
  });

export const createMcpRequestHandler = (
  runtime: ServerRuntime,
  apiHandler: ApiHandler,
): McpRequestHandler => {
  const expectedToken = runtime.config.mcpToken;
  const api = expectedToken
    ? createInternalApi(apiHandler, expectedToken)
    : null;
  const folderExists = api ? runtime.db.query("SELECT id FROM folders WHERE id = ?") : null;

  const mcp = expectedToken && api
    ? createMcpHandler(({ requestInfo }) => {
        const server = new McpServer(
          { name: "excalidrawsqlite", version: "1.0.0" },
          { maxToolInputElements: 100_000, instructions: MCP_SERVER_INSTRUCTIONS },
        );
        const safeTool = <T>(handler: (args: T) => Promise<ReturnType<typeof result>>, operation = "management") =>
          makeSafeTool(handler, runtime.config.mcpTrace, operation);
        const boardUrl = (id: string) => {
          const origin = requestInfo ? getRequestOrigin(runtime, requestInfo) : "";
          return `${origin}/?id=${encodeURIComponent(id)}`;
        };

        const readBoard = async ({
          boardId, view = "compact", elementIds, query, type, offset = 0,
          limit = 1_000, maxChars = 1_000_000,
        }: {
          boardId: string; view?: "summary" | "compact" | "elements" | "full" | "input"; elementIds?: string[];
          query?: string; type?: string; offset?: number; limit?: number; maxChars?: number;
        }) => {
          if (view === "summary") {
            if (elementIds || query || type || offset) {
              throw new HttpError(400, "INVALID_ARGUMENT", "summary 不读取图元，请省略图元筛选与 offset。");
            }
            const summary = await api<Record<string, unknown>>(`/api/scenes/${encodeURIComponent(boardId)}/summary`, "GET");
            const value = { ...cleanBoardRecord(summary), url: boardUrl(boardId) };
            if (JSON.stringify(value).length + 64 > maxChars) {
              throw new HttpError(400, "READ_BUDGET_TOO_SMALL", "画板摘要超过字符预算，请增加 maxChars。");
            }
            return value;
          }
          const board = await api<SceneData>(`/api/scenes/${encodeURIComponent(boardId)}`, "GET");
          const { writable, compact } = measureMcpPhase("transformMs", () => ({
            writable: view === "input" ? inputDrawingElements(board.elements) : null,
            compact: view === "compact" ? compactDrawingElements(board.elements) : null,
          }));
          // Semantic/input views collapse attached text before filtering/pagination.
          const source = (compact?.elements || writable?.elements || board.elements) as unknown as ExcalidrawElement[];
          const selected = elementIds ? new Set(elementIds.map((id) => compact?.labelOwners.get(id) || id)) : null;
          const needle = query?.toLocaleLowerCase();
          const matches = source.filter((element) =>
            (!selected || selected.has(element.id)) && (!type || element.type === type) &&
            (!needle || ("text" in element && typeof element.text === "string" && element.text.toLocaleLowerCase().includes(needle))),
          );
          const base = view === "full"
            ? { ...cleanBoardRecord(board), elements: [] as Record<string, unknown>[], elementCount: board.elements.length, url: boardUrl(board.id) }
            : { boardId: board.id, name: board.name, revision: board.revision, elementCount: board.elements.length,
                elements: [] as Record<string, unknown>[], url: boardUrl(board.id) };
          const allIds = selected ? new Set([...source.map((element) => element.id), ...compact?.labelOwners.keys() || []]) : null;
          const metadata = { ...base, matchedCount: matches.length, nextOffset: null, truncated: false,
            pointCoordinateSystem: view === "full" ? "relative" : "absolute",
            ...(writable ? { unsupportedElementIds: writable.unsupportedElementIds, warnings: writable.warnings } : {}),
            ...(selected ? { notFoundIds: elementIds!.filter((id) => !allIds!.has(id)) } : {}) };
          // Budget is charged per element rather than serializing another complete scene.
          // Reserve digits for the pagination offset and the outer structured result.
          let chars = JSON.stringify(metadata).length + 64;
          if (chars > maxChars) {
            throw new HttpError(400, "READ_BUDGET_TOO_SMALL", "画板元数据超过字符预算，请增加 maxChars 或使用 elements/summary。");
          }
          const elements: Record<string, unknown>[] = [];
          let index = offset;
          while (index < matches.length && elements.length < limit) {
            const current = matches[index];
            const element = view === "full" || view === "input" || view === "compact" ? current : {
              ...compactElement(current),
              ...(current.type === "arrow" || current.type === "line"
                ? { points: current.points.map((point) => [point[0] + current.x, point[1] + current.y]) } : {}),
            };
            const cost = JSON.stringify(element).length + 1;
            if (chars + cost > maxChars) break;
            chars += cost;
            elements.push(element as unknown as Record<string, unknown>);
            index++;
          }
          if (index === offset && index < matches.length) {
            throw new HttpError(400, "READ_BUDGET_TOO_SMALL", `图元 ${matches[index].id} 超过字符预算；请增加 maxChars 或改用 elements。`);
          }
          return { ...metadata, elements, nextOffset: index < matches.length ? index : null, truncated: index < matches.length };
        };

        server.registerTool(
          "list_boards",
          {
            title: "列出画板",
            description: "搜索画板摘要；支持文件夹、收藏、精确标签、最近打开和回收站视图。query 匹配名称/标签/文件夹名；cursor 接续 nextCursor，不回传图元。trash 固定按删除时间倒序。",
            inputSchema: compactMcpSchema(z.object({
              query: z.string().max(120).optional(),
              limit: z.number().int().min(1).max(100).optional(),
              cursor: z.string().max(2_000).optional(),
              folderId: z.string().min(1).max(128).nullable().optional().describe("null 仅根目录；省略则不限目录"),
              favorite: z.boolean().optional().describe("唯一的收藏筛选：true 仅收藏，false 仅未收藏，省略不限"),
              tag: z.string().trim().min(1).max(32).optional(),
              view: z.enum(["all", "recent", "trash"]).optional(),
              sort: z.enum(["updated", "created", "opened"]).optional(),
            }).strict()),
            annotations: {
              readOnlyHint: true,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          safeTool(async ({ query, limit, cursor, folderId, favorite, tag, view = "all", sort }) => {
            if (folderId && !folderExists!.get(folderId)) {
              throw new HttpError(404, "FOLDER_NOT_FOUND", "文件夹不存在，请使用 list_folders 确认 ID。");
            }
            if (view === "trash" && sort && sort !== "updated") {
              throw new HttpError(400, "INVALID_ARGUMENT", "trash 视图固定按删除时间倒序，请省略 sort。");
            }
            const params = new URLSearchParams({
              limit: String(limit || 50),
            });
            if (query?.trim()) params.set("q", query.trim());
            if (cursor) params.set("cursor", cursor);
            if (folderId !== undefined) params.set("folder_id", folderId || "");
            if (favorite !== undefined) params.set("favorite", String(favorite));
            if (tag) params.set("tag", tag);
            if (view === "recent") params.set("opened", "true");
            if (sort || view === "recent") params.set("sort", sort || "opened");
            const boards = await api<Record<string, unknown>>(
              `/api/scenes${view === "trash" ? "/trash" : ""}?${params.toString()}`,
              "GET",
            );
            return result(boards);
          }, "list_boards"),
        );

        server.registerTool(
          "get_board",
          {
            title: "读取画板",
            description: "默认 compact 只读视图保留文字、几何、连接，标签折入本体且省略装饰样式；elements 含样式；input 用于跨板复制，保留 ID，不能直接追加到原板；原地改用 update_element/update_board.updates。truncated/nextOffset 表示分页截断；仅 input 返回 unsupportedElementIds/warnings 表示无法可写投影，省略图元不代表空板。input/紧凑 points 绝对坐标，full 相对坐标。",
            inputSchema: compactMcpSchema(z.object({
              boardId: z.string().min(1).max(128),
              view: z.enum(["summary", "compact", "elements", "full", "input"]).optional(),
              elementIds: z.array(z.string().min(1).max(128)).min(1).max(1_000).optional(),
              query: z.string().trim().min(1).max(120).optional().describe("搜索文字；compact/input 匹配合并后的标签，type 筛选合并后的本体类型；elements/full 匹配独立文字"),
              type: z.enum(["rectangle", "ellipse", "diamond", "text", "line", "arrow", "image", "freedraw", "frame", "magicframe", "embeddable", "iframe"]).optional(),
              offset: z.number().int().min(0).optional(),
              limit: z.number().int().min(1).max(1_000).optional(),
              maxChars: z.number().int().min(1_000).max(2_000_000).optional().describe("图元与元数据总字符预算，默认1,000,000"),
            }).strict()),
            annotations: {
              readOnlyHint: true,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          safeTool(async (args) => result(await readBoard(args)), "get_board"),
        );

        server.registerTool(
          "create_board",
          {
            title: "创建画板",
            description: "一次创建画板并绘制全部内容。普通绘图直接传完整 elements，最多 1,000 个描述；省略 elements 创建空板。允许同名，不会覆盖已有画板。",
            inputSchema: compactMcpSchema(z.object({
              name: z.string().trim().min(1).max(120),
              elements: z.array(drawingElementSchema).max(1_000).optional(),
              backgroundColor: colorSchema.optional().describe("画布背景颜色，默认白色"),
              responseMode: responseModeSchema,
              ...boardMetadataSchema,
            }).strict()),
            annotations: {
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false,
            },
          },
          safeTool(async ({ name, elements = [], backgroundColor, folderId, folderName, tags, favorite, responseMode }) => {
            const { elements: drawing, created } = measureMcpPhase("transformMs", () => createDrawingBatch(elements));
            const resolvedFolder = await resolveFolder({ folderId, folderName }, api);
            const board = await api<{ id: string; name: string; revision: number }>(
              "/api/scenes",
              "POST",
              { name, elements: drawing, appState: { viewBackgroundColor: backgroundColor || "#ffffff" },
                ...(resolvedFolder === undefined ? {} : { folder_id: resolvedFolder }), tags, favorite },
            );
            return result({ boardId: board.id, name: board.name, revision: board.revision,
              elementCount: drawing.length, ...drawingReceipt(created, responseMode), url: boardUrl(board.id) });
          }, "create_board"),
        );

        server.registerTool("create_diagram", {
          title: "自动绘制流程图或时间线",
          description: "一次传节点标题/正文与连接，自动排版并创建画板，无需计算坐标。最多100节点/200连接，默认纵向流程图与forest主题；省略edges按顺序连接，[]不连线。节点id可直接用于后续更新。复杂自定义图元用create_board。",
          inputSchema: compactMcpSchema(diagramSchema.extend({ ...boardMetadataSchema, responseMode: responseModeSchema })),
          annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
        }, safeTool(async (args) => {
          const { diagram, drawing } = measureMcpPhase("transformMs", () => {
            const diagram = buildDiagram(args);
            return { diagram, drawing: createDrawingBatch(diagram.elements) };
          });
          const folder = await resolveFolder(args, api);
          const board = await api<{ id: string; name: string; revision: number }>("/api/scenes", "POST", {
            name: args.name, elements: drawing.elements, appState: { viewBackgroundColor: "#ffffff" },
            ...(folder === undefined ? {} : { folder_id: folder }), tags: args.tags, favorite: args.favorite,
          });
          return result({ boardId: board.id, name: board.name, revision: board.revision,
            nodeCount: diagram.nodeCount, edgeCount: diagram.edgeCount, layout: diagram.layout,
            direction: diagram.direction, theme: diagram.theme, elementCount: drawing.elements.length,
            ...drawingReceipt(drawing.created, args.responseMode), url: boardUrl(board.id) });
        }, "create_diagram"));

        server.registerTool(
          "add_elements",
          {
            title: "向画板绘制图元",
            description:
              "一次追加最多 1,000 个描述，不要逐个调用。矩形/椭圆/菱形的 text 自动绑定居中文字。混合删除、添加和改名优先 update_board。",
            inputSchema: compactMcpSchema(z.object({
              boardId: z.string().min(1).max(128),
              elements: z.array(drawingElementSchema).min(1).max(1_000),
              responseMode: responseModeSchema,
              expectedRevision: expectedRevisionSchema,
            }).strict()),
            annotations: {
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false,
            },
          },
          safeTool(async ({ boardId, elements, expectedRevision, responseMode }) => {
            const current = await api<SceneData>(
              `/api/scenes/${encodeURIComponent(boardId)}`,
              "GET",
            );
            assertRevision(current, expectedRevision);
            const { created, elements: merged } = measureMcpPhase("transformMs", () => createDrawingBatch(elements, current.elements));
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
              elementCount: merged.length,
              ...drawingReceipt(created, responseMode),
              revision: saved.revision,
              url: boardUrl(boardId),
            });
          }, "add_elements"),
        );

        server.registerTool(
          "remove_elements",
          {
            title: "从画板移除图元",
            description: "按图元 ID 永久移除指定画板中的图元。",
            inputSchema: compactMcpSchema(z.object({
              boardId: z.string().min(1).max(128),
              elementIds: z.array(z.string().min(1).max(128)).min(1).max(1_000),
              expectedRevision: expectedRevisionSchema,
            }).strict()),
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
            const { elements, removedCount } = measureMcpPhase("transformMs", () => removeDrawingElements(
              current.elements,
              elementIds,
            ));
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
          }, "remove_elements"),
        );

        server.registerTool(
          "update_board",
          {
            title: "批量修改画板",
            description: "一次原子保存：先删除 removeElementIds，再添加 elements，再按 updates 原地修改；还可同步改名、背景、收藏、标签及文件夹。修改保留图元ID与连接。新文件夹可用 folderName 自动获取或创建。",
            inputSchema: compactMcpSchema(z.object({
              boardId: z.string().min(1).max(128),
              expectedRevision: expectedRevisionSchema,
              elements: z.array(drawingElementSchema).min(1).max(1_000).optional(),
              removeElementIds: z.array(z.string().min(1).max(128)).min(1).max(1_000).optional(),
              updates: z.array(elementUpdateSchema).min(1).max(1_000).optional(),
              responseMode: responseModeSchema,
              name: z.string().trim().min(1).max(120).optional(),
              backgroundColor: colorSchema.optional(),
              ...boardMetadataSchema,
            }).strict()),
            annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
          },
          safeTool(async ({ boardId, expectedRevision, elements, removeElementIds, updates, name, backgroundColor, folderId, folderName, tags, favorite, responseMode }) => {
            if (!elements && !removeElementIds && !updates && name === undefined && backgroundColor === undefined &&
                folderId === undefined && folderName === undefined && tags === undefined && favorite === undefined) {
              throw new HttpError(400, "EMPTY_UPDATE", "请提供图元修改或画板元数据中至少一项。");
            }
            const current = await api<SceneData>(`/api/scenes/${encodeURIComponent(boardId)}`, "GET");
            assertRevision(current, expectedRevision);
            const { remaining, created, updated } = measureMcpPhase("transformMs", () => {
              const remaining = removeDrawingElements(current.elements, removeElementIds || []);
              const { created, elements: merged } = createDrawingBatch(elements || [], remaining.elements);
              return { remaining, created, updated: updateDrawingElements(merged, updates || []) };
            });
            if (!remaining.removedCount && !created.length && !updated.updatedCount && name === undefined &&
                backgroundColor === undefined && folderId === undefined && folderName === undefined &&
                tags === undefined && favorite === undefined) {
              return result({ boardId, revision: current.revision, elementCount: current.elements.length,
                ...drawingReceipt(created, responseMode), removedCount: 0, updatedCount: 0, noop: true, url: boardUrl(boardId) });
            }
            const resolvedFolder = await resolveFolder({ folderId, folderName }, api);
            const saved = await api<{ revision: number }>(`/api/scenes/${encodeURIComponent(boardId)}`, "PUT", {
              baseRevision: current.revision,
              ...(name === undefined ? {} : { name }),
              elements: updated.elements,
              appState: { ...current.appState, ...(backgroundColor === undefined ? {} : { viewBackgroundColor: backgroundColor }) },
              ...(resolvedFolder === undefined ? {} : { folder_id: resolvedFolder }), tags, favorite,
            });
            return result({ boardId, revision: saved.revision, elementCount: updated.elements.length, ...drawingReceipt(created, responseMode), removedCount: remaining.removedCount, updatedCount: updated.updatedCount,
              url: boardUrl(boardId) });
          }, "update_board"),
        );

        server.registerTool("update_element", {
          title: "原地修改图元",
          description: "按 update.id 原地修改，保留ID/连接/其余字段；形状text改绑定文字，labelStyle只改标签样式并保留未传字段。已有labelId仅用于核对，不能改名；新建标签可同时传text和labelId。批量用update_board.updates一次保存。",
          inputSchema: compactMcpSchema(z.strictObject({
            boardId: z.string().min(1).max(128),
            update: elementUpdateSchema,
            expectedRevision: expectedRevisionSchema,
          })),
          annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
        }, safeTool(async ({ boardId, update, expectedRevision }) => {
          const current = await api<SceneData>(`/api/scenes/${encodeURIComponent(boardId)}`, "GET");
          assertRevision(current, expectedRevision);
          const updated = measureMcpPhase("transformMs", () => updateDrawingElements(current.elements, [update]));
          if (!updated.updatedCount) {
            return result({ boardId, revision: current.revision, updatedCount: 0, noop: true });
          }
          const saved = await api<{ revision: number }>(`/api/scenes/${encodeURIComponent(boardId)}`, "PUT", {
            baseRevision: current.revision, elements: updated.elements, appState: current.appState,
          });
          return result({ boardId, revision: saved.revision, updatedCount: updated.updatedCount, elementId: update.id, url: boardUrl(boardId) });
        }, "update_element"));

        server.registerTool("get_boards_batch", {
          title: "批量读取画板",
          description: "一次读取最多20块画板，默认compact语义阅读；支持input可写视图，共享字符预算。partial仅表示成功失败混合，truncated仅表示内容或预算截断；不存在的ID只报错，无需续读。不构成跨画板一致快照。",
          inputSchema: compactMcpSchema(z.strictObject({
            boardIds: z.array(z.string().min(1).max(128)).min(1).max(20),
            view: z.enum(["summary", "compact", "elements", "full", "input"]).optional(),
            maxChars: z.number().int().min(1_000).max(2_000_000).optional().describe("含所有画板与逐项错误的总预算，最少1000；连结果元数据也放不下时报 READ_BUDGET_TOO_SMALL"),
          })),
          annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        }, safeTool(async ({ boardIds, view = "compact", maxChars = 1_000_000 }) => {
          const boards: Record<string, unknown>[] = boardIds.map((boardId) => ({ boardId, truncated: true,
            error: { code: "READ_BUDGET_EXHAUSTED", message: "预算不足，请单独读取该画板。" } }));
          const envelopeSize = () => JSON.stringify({ ok: true, boards, maxChars, partial: false, truncated: false }).length;
          if (envelopeSize() > maxChars) {
            throw new HttpError(400, "READ_BUDGET_TOO_SMALL", "批量结果的必要元数据超过预算，请增加 maxChars 或减少 boardIds。");
          }
          for (const [index, boardId] of boardIds.entries()) {
            // Charge the complete envelope while reserving a bounded outcome for every remaining board.
            const available = maxChars - envelopeSize() + JSON.stringify(boards[index]).length - 16;
            if (available < 128) continue;
            try {
              boards[index] = await readBoard({ boardId, view, maxChars: available });
            } catch (error) {
              if (!(error instanceof HttpError)) throw error;
              const outcome = { boardId, ...(error.code === "READ_BUDGET_TOO_SMALL" ? { truncated: true } : {}),
                error: { code: error.code, message: error.message } };
              if (JSON.stringify(outcome).length <= available) boards[index] = outcome;
            }
          }
          const failed = boards.filter((board) => board.error).length;
          return result({ boards, maxChars, partial: failed > 0 && failed < boards.length,
            truncated: boards.some((board) => board.truncated === true) });
        }, "get_boards_batch"));

        registerManagementTools(server, { runtime, api, result, safeTool, boardUrl });

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
      await mcp?.close();
    },
  };
};
