import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  colorSchema, drawingElementSchema, createDrawingBatch, removeDrawingElements,
  compactElement, elementUpdateSchema, updateDrawingElements, inputDrawingElements,
} from "./mcp-drawing";
import { registerManagementTools, resolveFolder } from "./mcp-management";

import { randomBase64Url, timingSafeEqual } from "./crypto";
import { HttpError } from "./errors";
import { isAllowedOrigin, jsonResponse, response } from "./http";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ServerRuntime } from "./types";

export const MCP_PATH = "/mcp";

const MCP_SERVER_INSTRUCTIONS = [
  "Excalidraw 白板支持搜索、读取及批量绘制。普通绘图优先 create_board 一次传入名称和全部 elements，不要先建空板再逐个绘制。",
  "每次最多 1,000 个图元描述；形状 text 自动绑定文字。可给节点指定 id，箭头 startBinding/endBinding.elementId 引用同批或已有节点，拖动节点时保持连接。折线 points 使用绝对画布坐标；二点仍可用 startX/startY/endX/endY。字段严格校验，不能输入原始内部字段。",
  "修改优先 update_board 一次合并添加、removeElementIds、updates 原地修改及元数据；只改一个图元用 update_element，保留 ID 和绑定。expectedRevision 是可选的已读修订号，服务端始终使用乐观锁；冲突后重新判断，禁止盲目重试。",
  "get_board 的 input 视图用于读改写：elements 可直接传给 create_board/add_elements，绑定文字合并到形状；points 是绝对坐标，rotation 是度。unsupportedElementIds/warnings 必须检查，不能声称完整复制不支持的图元或分组。默认紧凑视图只用于阅读，full 为内部格式且 points 是相对坐标。批读支持 input、分页和总字符预算。",
  "create_board 可同时设置 folderId/folderName、favorite、tags；folderName 会幂等获取或创建文件夹，重名歧义报错。文件夹用 list/ensure/create/update/delete_folder。manage_board 一次管理收藏、标签、移动和改名，batch_manage_boards 批量管理逐条返回结果。",
  "delete_board 只软删除，restore_board 还原；MCP 不提供永久删除或清空回收站。回收站受服务端保留期限约束。delete_folder 仅移画板至根目录，正式执行需 confirm=true，可先 dryRun 查看影响。",
  "完整机器结果位于 structuredContent，检查 ok 与 error.code；画板结果统一带 boardId，兼容 id。绘图回执的 requestedElementIds 是每个输入描述的本体，generatedElementIds 是附属文字，elementMap 按 inputIndex 对应本体与 labelId；elementIds 保留全部 ID。批读 partial 表示成功失败混合，truncated 仅表示内容/预算截断，not found 不需要续读。",
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
  }
  return clean;
};

const result = (value: Record<string, unknown>) => ({
  structuredContent: { ok: !value.error, ...cleanBoardRecord(value),
    ...Object.fromEntries(["items", "boards", "results"].filter((key) => Array.isArray(value[key]))
      .map((key) => [key, (value[key] as Record<string, unknown>[]).map(cleanBoardRecord)])),
  },
  content: [{ type: "text" as const, text: value.error
    ? `操作失败：${(value.error as { message: string }).message}`
    : "操作成功；详情见 structuredContent。" }],
});

const drawingReceipt = (created: readonly ExcalidrawElement[]) => {
  const ids = new Set(created.map((element) => element.id));
  const generated = created.filter((element) => element.type === "text" && element.containerId && ids.has(element.containerId));
  const generatedIds = new Set(generated.map((element) => element.id));
  const requested = created.filter((element) => !generatedIds.has(element.id));
  return {
    addedCount: created.length,
    elementIds: created.map((element) => element.id),
    requestedElementIds: requested.map((element) => element.id),
    generatedElementIds: generated.map((element) => element.id),
    elementMap: requested.map((element, inputIndex) => ({ inputIndex, elementId: element.id,
      ...(element.boundElements?.find((bound) => bound.type === "text")
        ? { labelId: element.boundElements.find((bound) => bound.type === "text")!.id } : {}),
    })),
  };
};

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

const createInternalApi = (apiHandler: ApiHandler, sessionToken: string) =>
  async <T>(path: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown) => {
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
  const folderExists = api ? runtime.db.query("SELECT id FROM folders WHERE id = ?") : null;

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

        const readBoard = async ({
          boardId, view = "elements", elementIds, query, type, offset = 0,
          limit = 1_000, maxChars = 1_000_000,
        }: {
          boardId: string; view?: "summary" | "elements" | "full" | "input"; elementIds?: string[];
          query?: string; type?: string; offset?: number; limit?: number; maxChars?: number;
        }) => {
          if (view === "summary") {
            if (elementIds || query || type || offset) {
              throw new HttpError(400, "INVALID_ARGUMENT", "summary 不读取图元，请省略图元筛选与 offset。");
            }
            const summary = await api<Record<string, unknown>>(`/api/scenes/${encodeURIComponent(boardId)}/summary`, "GET");
            return { ...summary, url: boardUrl(boardId) };
          }
          const board = await api<SceneData>(`/api/scenes/${encodeURIComponent(boardId)}`, "GET");
          const writable = view === "input" ? inputDrawingElements(board.elements) : null;
          // Input view collapses attached text into its owner before filtering/pagination.
          const source = writable ? writable.elements as unknown as ExcalidrawElement[] : board.elements;
          const selected = elementIds ? new Set(elementIds) : null;
          const needle = query?.toLocaleLowerCase();
          const matches = source.filter((element) =>
            (!selected || selected.has(element.id)) && (!type || element.type === type) &&
            (!needle || ("text" in element && typeof element.text === "string" && element.text.toLocaleLowerCase().includes(needle))),
          );
          const base = view === "full"
            ? { ...cleanBoardRecord(board), elements: [] as Record<string, unknown>[], elementCount: board.elements.length, url: boardUrl(board.id) }
            : { id: board.id, name: board.name, revision: board.revision, elementCount: board.elements.length,
                elements: [] as Record<string, unknown>[], url: boardUrl(board.id) };
          const allIds = selected ? new Set(source.map((element) => element.id)) : null;
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
            const element = view === "full" || view === "input" ? current : {
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
            inputSchema: z.object({
              query: z.string().max(120).optional(),
              limit: z.number().int().min(1).max(100).optional(),
              cursor: z.string().max(2_000).optional(),
              folderId: z.string().min(1).max(128).nullable().optional().describe("null 仅根目录；省略则不限目录"),
              favorite: z.boolean().optional(),
              tag: z.string().trim().min(1).max(32).optional(),
              view: z.enum(["all", "recent", "favorite", "favorites", "trash"]).optional().describe("收藏视图使用 favorite；favorites 是兼容别名，也可直接用 favorite=true 筛选"),
              sort: z.enum(["updated", "created", "opened"]).optional(),
            }).strict(),
            annotations: {
              readOnlyHint: true,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          safeTool(async ({ query, limit, cursor, folderId, favorite, tag, view = "all", sort }) => {
            const isFavoriteView = view === "favorite" || view === "favorites";
            if (isFavoriteView && favorite === false) {
              throw new HttpError(400, "INVALID_ARGUMENT", "favorite 视图不能同时指定 favorite=false。");
            }
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
            if (favorite !== undefined || isFavoriteView) params.set("favorite", String(favorite ?? true));
            if (tag) params.set("tag", tag);
            if (view === "recent") params.set("opened", "true");
            if (sort || view === "recent") params.set("sort", sort || "opened");
            const boards = await api<Record<string, unknown>>(
              `/api/scenes${view === "trash" ? "/trash" : ""}?${params.toString()}`,
              "GET",
            );
            return result(boards);
          }),
        );

        server.registerTool(
          "get_board",
          {
            title: "读取画板",
            description: "读取修订号与图元；input 输出可直接写入的 elements（绑定文字合并到形状，points绝对坐标），检查unsupportedElementIds/warnings。默认紧凑用于阅读，full内部格式points相对坐标。支持ID/文字/type筛选及nextOffset分页。",
            inputSchema: z.object({
              boardId: z.string().min(1).max(128),
              view: z.enum(["summary", "elements", "full", "input"]).optional(),
              elementIds: z.array(z.string().min(1).max(128)).min(1).max(1_000).optional(),
              query: z.string().trim().min(1).max(120).optional().describe("搜索文字；input 视图匹配合并后的形状标签，其他视图匹配独立文字图元"),
              type: z.enum(["rectangle", "ellipse", "diamond", "text", "line", "arrow", "image", "freedraw", "frame", "magicframe", "embeddable", "iframe"]).optional(),
              offset: z.number().int().min(0).optional(),
              limit: z.number().int().min(1).max(1_000).optional(),
              maxChars: z.number().int().min(1_000).max(2_000_000).optional().describe("图元与元数据总字符预算，默认1,000,000"),
            }).strict(),
            annotations: {
              readOnlyHint: true,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          safeTool(async (args) => result(await readBoard(args))),
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
              ...boardMetadataSchema,
            }).strict(),
            annotations: {
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false,
            },
          },
          safeTool(async ({ name, elements = [], backgroundColor, folderId, folderName, tags, favorite }) => {
            const { elements: drawing, created } = createDrawingBatch(elements);
            const resolvedFolder = await resolveFolder({ folderId, folderName }, api);
            const board = await api<{ id: string; name: string; revision: number }>(
              "/api/scenes",
              "POST",
              { name, elements: drawing, appState: { viewBackgroundColor: backgroundColor || "#ffffff" },
                ...(resolvedFolder === undefined ? {} : { folder_id: resolvedFolder }), tags, favorite },
            );
            return result({ ...board, ...drawingReceipt(created), url: boardUrl(board.id) });
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
            const { created, elements: merged } = createDrawingBatch(elements, current.elements);
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
              ...drawingReceipt(created),
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
            description: "一次原子保存：先删除 removeElementIds，再添加 elements，再按 updates 原地修改；还可同步改名、背景、收藏、标签及文件夹。修改保留图元ID与连接。新文件夹可用 folderName 自动获取或创建。",
            inputSchema: z.object({
              boardId: z.string().min(1).max(128),
              expectedRevision: expectedRevisionSchema,
              elements: z.array(drawingElementSchema).min(1).max(1_000).optional(),
              removeElementIds: z.array(z.string().min(1).max(128)).min(1).max(1_000).optional(),
              updates: z.array(elementUpdateSchema).min(1).max(1_000).optional(),
              name: z.string().trim().min(1).max(120).optional(),
              backgroundColor: colorSchema.optional(),
              ...boardMetadataSchema,
            }).strict(),
            annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
          },
          safeTool(async ({ boardId, expectedRevision, elements, removeElementIds, updates, name, backgroundColor, folderId, folderName, tags, favorite }) => {
            if (!elements && !removeElementIds && !updates && name === undefined && backgroundColor === undefined &&
                folderId === undefined && folderName === undefined && tags === undefined && favorite === undefined) {
              throw new HttpError(400, "EMPTY_UPDATE", "请提供图元修改或画板元数据中至少一项。");
            }
            const current = await api<SceneData>(`/api/scenes/${encodeURIComponent(boardId)}`, "GET");
            assertRevision(current, expectedRevision);
            const remaining = removeDrawingElements(current.elements, removeElementIds || []);
            const { created, elements: merged } = createDrawingBatch(elements || [], remaining.elements);
            const updated = updateDrawingElements(merged, updates || []);
            const resolvedFolder = await resolveFolder({ folderId, folderName }, api);
            const saved = await api<{ revision: number }>(`/api/scenes/${encodeURIComponent(boardId)}`, "PUT", {
              baseRevision: current.revision,
              ...(name === undefined ? {} : { name }),
              elements: updated.elements,
              appState: { ...current.appState, ...(backgroundColor === undefined ? {} : { viewBackgroundColor: backgroundColor }) },
              ...(resolvedFolder === undefined ? {} : { folder_id: resolvedFolder }), tags, favorite,
            });
            return result({ boardId, revision: saved.revision, ...drawingReceipt(created), removedCount: remaining.removedCount, updatedCount: updated.updatedCount,
              url: boardUrl(boardId) });
          }),
        );

        server.registerTool("update_element", {
          title: "原地修改图元",
          description: "只传待改字段，按 update.id 原地修改，保留ID/连接/其余字段；形状text修改绑定文字。批量改多个图元用 update_board.updates，一次保存。",
          inputSchema: z.strictObject({
            boardId: z.string().min(1).max(128),
            update: elementUpdateSchema,
            expectedRevision: expectedRevisionSchema,
          }),
          annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
        }, safeTool(async ({ boardId, update, expectedRevision }) => {
          const current = await api<SceneData>(`/api/scenes/${encodeURIComponent(boardId)}`, "GET");
          assertRevision(current, expectedRevision);
          const updated = updateDrawingElements(current.elements, [update]);
          if (!updated.updatedCount) {
            return result({ boardId, revision: current.revision, updatedCount: 0, noop: true });
          }
          const saved = await api<{ revision: number }>(`/api/scenes/${encodeURIComponent(boardId)}`, "PUT", {
            baseRevision: current.revision, elements: updated.elements, appState: current.appState,
          });
          return result({ boardId, revision: saved.revision, updatedCount: updated.updatedCount, elementId: update.id, url: boardUrl(boardId) });
        }));

        server.registerTool("get_boards_batch", {
          title: "批量读取画板",
          description: "一次读取最多20块画板，支持input可写视图，共享字符预算。partial仅表示成功失败混合，truncated仅表示内容或预算截断；不存在的ID只报错，无需续读。不构成跨画板一致快照。",
          inputSchema: z.strictObject({
            boardIds: z.array(z.string().min(1).max(128)).min(1).max(20),
            view: z.enum(["summary", "elements", "full", "input"]).optional(),
            maxChars: z.number().int().min(10_000).max(2_000_000).optional(),
          }),
          annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        }, safeTool(async ({ boardIds, view = "elements", maxChars = 1_000_000 }) => {
          const boards: Record<string, unknown>[] = [];
          // Reserve space for per-board errors, pagination flags and the result envelope.
          let remaining = maxChars - 5_000;
          for (const boardId of boardIds) {
            if (remaining < 1_000) {
              boards.push({ boardId, truncated: true, error: { code: "READ_BUDGET_EXHAUSTED", message: "总字符预算已用完，请单独读取该画板。" } });
              continue;
            }
            try {
              const board = await readBoard({ boardId, view, maxChars: Math.max(1_000, remaining - 500) });
              remaining -= JSON.stringify(board).length;
              boards.push(board);
            } catch (error) {
              if (!(error instanceof HttpError)) throw error;
              boards.push({ boardId, ...(error.code === "READ_BUDGET_TOO_SMALL" ? { truncated: true } : {}),
                error: { code: error.code, message: error.message } });
            }
          }
          const failed = boards.filter((board) => board.error).length;
          return result({ boards, maxChars, partial: failed > 0 && failed < boards.length,
            truncated: boards.some((board) => board.truncated === true) });
        }));

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
      if (internalSessionToken) {
        runtime.sessions.delete(internalSessionToken);
      }
      await mcp?.close();
    },
  };
};
