import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  colorSchema, drawingElementSchema, createDrawingBatch, removeDrawingElements,
  compactElement, elementUpdateSchema, updateDrawingElements, inputDrawingElements,
  measureDrawingText,
} from "./mcp-drawing";
import { compactDrawingElements } from "./mcp-read";
import { copyDrawingSelection } from "./mcp-copy";
import { inspectDrawingOverlaps } from "./mcp-overlap";
import { registerManagementTools, resolveFolder } from "./mcp-management";
import { measureMcpApi, measureMcpPhase, traceMcpTool } from "./mcp-trace";
import { compactMcpSchema } from "./mcp-schema";
import { buildDiagram, diagramSchema } from "./mcp-diagram";
import { measureTextSchema, layoutSchema, buildDrawingLayout } from "./mcp-layout";
import { autoBindArrowEndpoints } from "./mcp-autobind";
import { registerMcpCreateSession, unregisterMcpCreateSession, lookupMcpCreateReplay } from "./create-idempotency";
import { inspectLayout, inspectLayoutSchema } from "./mcp-inspect";
import { formatMcpSummary } from "./mcp-summary";

import { randomBase64Url, timingSafeEqual } from "./crypto";
import { HttpError } from "./errors";
import { getRequestOrigin, isAllowedOrigin, jsonResponse, response } from "./http";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ServerRuntime } from "./types";

export const MCP_PATH = "/mcp";

const getMcpServerInstructions = (runtime: ServerRuntime) => [
  "狐涂画板 MCP 使用简化绘图描述，参数以工具 schema 为准，不接受原生 Excalidraw JSON。",
  "创建时一次提交全部内容：自由绘图用 create_board，流程/时间线/架构/泳道用 create_diagram，卡片网格用 create_layout；创建重试复用 idempotencyKey。",
  "修改用 update_board 批量原地更新，复制用 copy_elements；保留已有图元 ID 和连接。已读版本通过 expectedRevision 校验，冲突后重新读取判断，不盲目重试。",
  "常规读取用 get_board 的 compact，修改前用 input；仅 elements 可直接作为 updates，只读 elementGeometry 不可写回。分页、截断及 unsupportedElementIds/warnings 不代表完整场景，不能据此覆盖全板。",
  "文字 width 控制换行，height 自动计算。形状 text 为绑定标签，复杂卡片的独立文字与背景用 groupId 关联；需要随节点移动的连线用绑定 arrow，无箭头时 endArrowhead=null。MCP 移动/复制只处理指定 IDs，不自动扩展整个分组。",
  "structuredContent 是完整结果，text 是简要摘要。单次失败检查 isError 和 ok/error；参数校验可能仅有 isError/text，批处理须逐项检查 ok/error。",
  "创建后 inspect_layout 检查，再按图元 ID 修改并复查；complete=false 或容器跳过不等于通过。诊断和文字尺寸均为几何估算，建议需结合设计意图判断，工具不自动修复。",
  `delete_board 仅移入回收站，restore_board 还原，无永久删除工具。${runtime.config.trashRetentionDays === 0 ? "回收站自动清理已禁用。" : `回收站保留 ${runtime.config.trashRetentionDays} 天后自动清理。`}`,
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

const result = (value: Record<string, unknown>) => measureMcpPhase("responseBuildMs", () => {
  const structuredContent = { ok: !value.error, ...cleanBoardRecord(value),
    ...Object.fromEntries(["items", "boards", "results", "folders"].filter((key) => Array.isArray(value[key]))
      .map((key) => [key, (value[key] as Record<string, unknown>[]).map(cleanBoardRecord)])),
    ...(value.folder && typeof value.folder === "object"
      ? { folder: cleanBoardRecord(value.folder as Record<string, unknown>) } : {}),
  };
  return { structuredContent, content: [] as Array<{ type: "text"; text: string }> };
});

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

const positionReceipt = (elements: readonly ExcalidrawElement[], id: string) => {
  const element = elements.find((item) => item.id === id && !item.isDeleted);
  if (!element) return { elementId: id };
  const geometry = (item: ExcalidrawElement) => ({ x: item.x, y: item.y, width: item.width, height: item.height });
  const labelId = element.boundElements?.find((bound) => bound.type === "text")?.id;
  const label = labelId ? elements.find((item) => item.id === labelId && !item.isDeleted) : undefined;
  return { elementId: id, ...geometry(element), ...(label ? { label: { id: label.id, ...geometry(label) } } : {}) };
};

const makeSafeTool = <T>(handler: (args: T) => Promise<ReturnType<typeof result>>, trace = false, operation = "tool") =>
  async (args: T) => traceMcpTool(trace, operation, async () => {
    let completed: ReturnType<typeof result>;
    try {
      completed = await handler(args);
    } catch (error) {
      if (error instanceof HttpError) {
        completed = result({ error: { code: error.code, message: error.message } });
      } else throw error;
    }
    return measureMcpPhase("responseBuildMs", () => ({ ...completed,
      ...(completed.structuredContent.ok === false ? { isError: true } : {}),
      content: [{ type: "text" as const, text: formatMcpSummary(operation, completed.structuredContent) }] }));
  });

const expectedRevisionSchema = z.number().int().positive().optional()
  .describe("可选的读取时修订号；省略时读取最新版本，仍使用乐观锁保存");
const idempotencyKeySchema = z.string().min(1).max(128).refine((key) => !!key.trim(), "幂等 key 不能为空").optional()
  .describe("可选创建幂等 key，有效 24 小时；相同 key/参数重试返回已有画板当前摘要，addedCount=0，不重新绘制；改参数须换 key");
const autoBindSchema = z.boolean().default(false).describe("显式开启时，对新箭头未绑定端点尝试 24px 内最近形状绑定；保留原坐标，歧义不猜。默认关闭；超过检测预算返回 autoBinding.complete=false");
const createIntent = (tool: string, args: Record<string, unknown>) => {
  const { idempotencyKey: _key, responseMode: _mode, ...payload } = args;
  return { tool, args: payload };
};
const bindCreated = (drawing: { elements: ExcalidrawElement[]; created: ExcalidrawElement[] }, enabled: boolean) => {
  if (!enabled) return { ...drawing, autoBinding: undefined };
  const createdIds = new Set(drawing.created.map((element) => element.id));
  const { elements, ...autoBinding } = autoBindArrowEndpoints(drawing.elements, [...createdIds]);
  return { elements, created: elements.filter((element) => createdIds.has(element.id)), autoBinding };
};

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

const createRequestBodyLimiter = (maxConcurrent: number) => {
  let active = 0;
  const waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
    remove: () => void;
    settled: boolean;
  }> = [];

  const releaseSlot = () => {
    active = Math.max(0, active - 1);
    while (waiters.length) {
      const waiter = waiters.shift()!;
      if (waiter.settled) {
        continue;
      }
      waiter.settled = true;
      waiter.remove();
      active += 1;
      waiter.resolve();
      return;
    }
  };

  return {
    acquire: (signal?: AbortSignal) =>
      new Promise<() => void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("The request was aborted", "AbortError"));
          return;
        }
        if (active < maxConcurrent) {
          active += 1;
          let released = false;
          resolve(() => {
            if (!released) {
              released = true;
              releaseSlot();
            }
          });
          return;
        }

        const waiter = {
          resolve: () => {
            let released = false;
            resolve(() => {
              if (!released) {
                released = true;
                releaseSlot();
              }
            });
          },
          reject: (error: unknown) => {
            if (waiter.settled) {
              return;
            }
            waiter.settled = true;
            waiter.remove();
            reject(error);
          },
          remove: () => {
            signal?.removeEventListener("abort", abort);
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
          },
          settled: false,
        };
        const abort = () =>
          waiter.reject(new DOMException("The request was aborted", "AbortError"));
        signal?.addEventListener("abort", abort, { once: true });
        waiters.push(waiter);
      }),
  };
};

const createInternalApi = (apiHandler: ApiHandler, token: string, createSessionToken: string) =>
  async <T>(path: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown) => measureMcpApi(method, async () => {
    const req = new Request(`http://excalidraw-mcp.internal${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Mcp-Create-Session": createSessionToken,
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
  const maxConcurrentBodyRequests = Math.max(
    1,
    Math.floor(
      runtime.config.maxInFlightBodyBytes / runtime.config.maxSceneBodyBytes,
    ) - 1,
  );
  const requestBodyLimiter = createRequestBodyLimiter(
    maxConcurrentBodyRequests,
  );
  const internalSessionToken = expectedToken ? randomBase64Url(32) : null;
  if (internalSessionToken) {
    // MCP calls pass through the exact same route validation and persistence
    // logic as the browser, using a private in-memory session never exposed to
    // network requests or persisted to SQLite.
    registerMcpCreateSession(runtime, internalSessionToken);
  }

  const api = expectedToken && internalSessionToken
    ? createInternalApi(apiHandler, expectedToken, internalSessionToken)
    : null;
  const folderExists = api ? runtime.db.query("SELECT id FROM folders WHERE id = ?") : null;

  const mcp = expectedToken && api
    ? createMcpHandler(({ requestInfo }) => {
        const server = new McpServer(
          { name: "excalidrawsqlite", version: "1.0.0" },
          { maxToolInputElements: 100_000, instructions: getMcpServerInstructions(runtime) },
        );
        const safeTool = <T>(handler: (args: T) => Promise<ReturnType<typeof result>>, operation: string) =>
          makeSafeTool(handler, runtime.config.mcpTrace, operation);
        const boardUrl = (id: string) => {
          const origin = requestInfo ? getRequestOrigin(runtime, requestInfo) : "";
          return `${origin}/?id=${encodeURIComponent(id)}`;
        };
        const replayReceipt = (board: Record<string, unknown>) => result({ ...board,
          addedCount: 0, idempotentReplay: true, url: boardUrl(String(board.id ?? board.boardId)) });
        const creationReplay = (key: string | undefined, intent: unknown) => lookupMcpCreateReplay(runtime, key, intent);

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
          const labelOwners = compact?.labelOwners || writable?.labelOwners;
          const selected = elementIds ? new Set(elementIds.map((id) => labelOwners?.get(id) || id)) : null;
          const needle = query?.toLocaleLowerCase();
          const matches = source.filter((element) =>
            (!selected || selected.has(element.id)) && (!type || element.type === type) &&
            (!needle || ("text" in element && typeof element.text === "string" && element.text.toLocaleLowerCase().includes(needle))),
          );
          const base = view === "full"
            ? { ...cleanBoardRecord(board), elements: [] as Record<string, unknown>[], elementCount: board.elements.length, url: boardUrl(board.id) }
            : { boardId: board.id, name: board.name, revision: board.revision, elementCount: board.elements.length,
                elements: [] as Record<string, unknown>[], url: boardUrl(board.id) };
          const allIds = selected ? new Set([...source.map((element) => element.id), ...labelOwners?.keys() || []]) : null;
          const metadata = { ...base, viewElementCount: source.length, returnedElementCount: 0,
            matchedCount: matches.length, nextOffset: null, truncated: false,
            pointCoordinateSystem: "relative",
            ...(writable ? { unsupportedElementIds: writable.unsupportedElementIds, warnings: writable.warnings } : {}),
            ...(writable ? { elementGeometry: [] as Record<string, unknown>[] } : {}),
            ...(selected ? { notFoundIds: elementIds!.filter((id) => !allIds!.has(id)) } : {}) };
          // Budget is charged per element rather than serializing another complete scene.
          // Reserve digits for the pagination offset and the outer structured result.
          let chars = JSON.stringify(metadata).length + 64;
          if (chars > maxChars) {
            throw new HttpError(400, "READ_BUDGET_TOO_SMALL", "画板元数据超过字符预算，请增加 maxChars 或使用 elements/summary。");
          }
          const elements: Record<string, unknown>[] = [];
          const elementGeometry: Record<string, unknown>[] = [];
          const nativeElements = writable ? new Map(board.elements.map((element) => [element.id, element])) : null;
          let index = offset;
          while (index < matches.length && elements.length < limit) {
            const current = matches[index];
            const element = view === "full" || view === "input" || view === "compact" ? current : {
              ...compactElement(current),
              ...(current.type === "arrow" || current.type === "line"
                ? { points: current.points } : {}),
            };
            const native = nativeElements?.get(current.id);
            const geometry = native?.type === "text" ? { elementId: native.id, height: native.height,
              lineHeight: native.lineHeight, lineHeightPx: native.fontSize * native.lineHeight,
              lineCount: native.text.split("\n").length } : null;
            const cost = JSON.stringify(element).length + 1 + (geometry ? JSON.stringify(geometry).length + 1 : 0);
            if (chars + cost > maxChars) break;
            chars += cost;
            elements.push(element as unknown as Record<string, unknown>);
            if (geometry) elementGeometry.push(geometry);
            index++;
          }
          if (index === offset && index < matches.length) {
            throw new HttpError(400, "READ_BUDGET_TOO_SMALL", `图元 ${matches[index].id} 超过字符预算；请增加 maxChars 或改用 elements。`);
          }
          return { ...metadata, elements, ...(writable ? { elementGeometry } : {}), returnedElementCount: elements.length,
            nextOffset: index < matches.length ? index : null, truncated: index < matches.length };
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
            if (folderId && !(await folderExists!.get(folderId))) {
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
            description: "默认 compact 只读视图保留文字、几何、连接，标签折入本体且省略装饰样式；elements 含样式；input 返回可直接用于 update_board.updates 的描述，type 仅核对类型，已有 ID 不能追加；复制优先 copy_elements。input/紧凑视图按标签 ID 筛选返回本体。truncated/nextOffset 表示分页截断；仅 input 返回 unsupportedElementIds/warnings 表示无法可写投影，省略图元不代表空板。所有视图的 points 均相对图元 x/y 原点。",
            inputSchema: compactMcpSchema(z.object({
              boardId: z.string().min(1).max(128),
              view: z.enum(["summary", "compact", "elements", "full", "input"]).optional()
                .describe("input.elements 可直接写回，文字只读高度/行高在同页 elementGeometry，勿合并进 updates；其他视图用于阅读"),
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

        server.registerTool("inspect_layout", {
          title: "检查画板几何布局",
          description: "只读检查文字重叠、容器内文字溢出、可能的元素碰撞和已绑定箭头连接异常。默认检查全部四项，可用 checks 筛选。使用现有图元尺寸，无浏览器或字体像素测量；正常包含、装饰箭头和无限画布负坐标不视为错误。不自动修改；根据 issues.elementIds 调用 update_board 后复查。complete=false 表示预算截断，未发现问题不保证视觉正确。",
          inputSchema: compactMcpSchema(inspectLayoutSchema.extend({ boardId: z.string().min(1).max(128) })),
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        }, safeTool(async ({ boardId, checks, inferTextContainers }) => {
          const current = await api<SceneData>(`/api/scenes/${encodeURIComponent(boardId)}`, "GET");
          return result({ boardId, revision: current.revision,
            ...measureMcpPhase("transformMs", () => inspectLayout(current.elements, { checks, inferTextContainers })) });
        }, "inspect_layout"));

        server.registerTool("measure_text", {
          title: "估算文字换行与尺寸",
          description: "创建前估算文字自然宽度或固定 width 下的换行、宽高；与 MCP 创建文字使用相同服务端估算器，不读取或修改画板。中文和其他字符采用估算宽度，字体实际效果请预览复查。",
          inputSchema: compactMcpSchema(measureTextSchema),
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        }, safeTool(async (args) => result(measureMcpPhase("transformMs", () => measureDrawingText(args))), "measure_text"));

        server.registerTool("create_layout", {
          title: "自动创建卡片网格画板",
          description: "一次传入最多100张 cards（title/body），自动换行、测高和分列，无需逐个计算坐标。每张背景、标题、正文共享原生分组，编辑器可整体拖动；cards.elementIds 可用于 MCP 批量移动/复制，MCP 按指定 ID 操作。mode 当前支持 grid。返回卡片及布局边界；文字尺寸是服务端估算，创建后可用 inspect_layout 复查。",
          inputSchema: compactMcpSchema(layoutSchema.safeExtend({
            name: z.string().trim().min(1).max(120),
            ...boardMetadataSchema,
            responseMode: responseModeSchema,
            idempotencyKey: idempotencyKeySchema,
          })),
          annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
        }, safeTool(async (args) => {
          const intent = createIntent("create_layout", args);
          const replay = await creationReplay(args.idempotencyKey, intent);
          if (replay) return replayReceipt(replay);
          const { layout, drawing } = measureMcpPhase("transformMs", () => {
            const layout = buildDrawingLayout(args);
            return { layout, drawing: createDrawingBatch(layout.elements) };
          });
          const folder = await resolveFolder(args, api);
          const board = await api<{ id: string; name: string; revision: number; idempotentReplay?: boolean }>("/api/scenes", "POST", {
            name: args.name, elements: drawing.elements, appState: { viewBackgroundColor: "#ffffff" },
            ...(folder === undefined ? {} : { folder_id: folder }), tags: args.tags, favorite: args.favorite,
            ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey, idempotencyPayload: intent } : {}),
          });
          if (board.idempotentReplay) return replayReceipt(board);
          return result({ boardId: board.id, name: board.name, revision: board.revision,
            elementCount: drawing.elements.length, ...drawingReceipt(drawing.created, args.responseMode),
            cards: layout.cards, bounds: layout.bounds, estimated: layout.estimated, note: layout.note, url: boardUrl(board.id) });
        }, "create_layout"));

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
              idempotencyKey: idempotencyKeySchema,
              autoBind: autoBindSchema,
              ...boardMetadataSchema,
            }).strict()),
            annotations: {
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false,
            },
          },
          safeTool(async (args) => {
            const { name, elements = [], backgroundColor, folderId, folderName, tags, favorite, responseMode, idempotencyKey, autoBind } = args;
            const intent = createIntent("create_board", args);
            const replay = await creationReplay(idempotencyKey, intent);
            if (replay) return replayReceipt(replay);
            const { elements: drawing, created, autoBinding } = measureMcpPhase("transformMs", () => bindCreated(createDrawingBatch(elements), autoBind));
            const resolvedFolder = await resolveFolder({ folderId, folderName }, api);
            const board = await api<{ id: string; name: string; revision: number; idempotentReplay?: boolean }>(
              "/api/scenes",
              "POST",
              { name, elements: drawing, appState: { viewBackgroundColor: backgroundColor || "#ffffff" },
                ...(resolvedFolder === undefined ? {} : { folder_id: resolvedFolder }), tags, favorite,
                ...(idempotencyKey ? { idempotencyKey, idempotencyPayload: intent } : {}) },
            );
            if (board.idempotentReplay) return replayReceipt(board);
            return result({ boardId: board.id, name: board.name, revision: board.revision,
              elementCount: drawing.length, ...drawingReceipt(created, responseMode), ...(autoBinding ? { autoBinding } : {}), url: boardUrl(board.id) });
          }, "create_board"),
        );

        server.registerTool("create_diagram", {
          title: "自动绘制流程、架构或泳道图",
          description: "一次传节点标题/正文与连接自动排版。layout支持flowchart/timeline/architecture/swimlane，最多100节点/200连接/24区域。architecture区域最多两级，swimlane平级且默认横向；高级模式传regions与nodes.regionId，省略edges不连线，普通模式省略edges按顺序连接。edges.endArrowhead=null为无箭头绑定连接。返回区域ID/分组/节点归属/边界；文字尺寸为服务端估算，创建后inspect_layout复查。",
          inputSchema: compactMcpSchema(diagramSchema.safeExtend({ ...boardMetadataSchema, responseMode: responseModeSchema, idempotencyKey: idempotencyKeySchema })),
          annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
        }, safeTool(async (args) => {
          const intent = createIntent("create_diagram", args);
          const replay = await creationReplay(args.idempotencyKey, intent);
          if (replay) return replayReceipt(replay);
          const { diagram, drawing } = measureMcpPhase("transformMs", () => {
            const diagram = buildDiagram(args);
            return { diagram, drawing: createDrawingBatch(diagram.elements) };
          });
          const folder = await resolveFolder(args, api);
          const board = await api<{ id: string; name: string; revision: number; idempotentReplay?: boolean }>("/api/scenes", "POST", {
            name: args.name, elements: drawing.elements, appState: { viewBackgroundColor: "#ffffff" },
            ...(folder === undefined ? {} : { folder_id: folder }), tags: args.tags, favorite: args.favorite,
            ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey, idempotencyPayload: intent } : {}),
          });
          if (board.idempotentReplay) return replayReceipt(board);
          return result({ boardId: board.id, name: board.name, revision: board.revision,
            nodeCount: diagram.nodeCount, edgeCount: diagram.edgeCount, layout: diagram.layout,
            direction: diagram.direction, theme: diagram.theme, elementCount: drawing.elements.length,
            ...("regions" in diagram ? { regions: diagram.regions, bounds: diagram.bounds,
              nodeRegions: diagram.nodeRegions, estimated: diagram.estimated } : {}),
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
              autoBind: autoBindSchema,
            }).strict()),
            annotations: {
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false,
            },
          },
          safeTool(async ({ boardId, elements, expectedRevision, responseMode, autoBind }) => {
            const current = await api<SceneData>(
              `/api/scenes/${encodeURIComponent(boardId)}`,
              "GET",
            );
            assertRevision(current, expectedRevision);
            const { created, elements: merged, autoBinding } = measureMcpPhase("transformMs", () => bindCreated(createDrawingBatch(elements, current.elements), autoBind));
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
              ...(autoBinding ? { autoBinding } : {}),
              url: boardUrl(boardId),
            });
          }, "add_elements"),
        );

        server.registerTool("copy_elements", {
          title: "复制图元到当前或其他画板",
          description: "复制最多1000个图元描述，自动生成新ID并重连选择集内箭头；标签ID会连同所属形状一起复制。targetBoardId省略表示同板复制，dx/dy默认20。外部绑定默认解绑；preserve仅同板可用。只复制input视图可写图元，不能投影时整次拒绝；省略的原生元数据见warnings。返回idMap，无需手工改ID。",
          inputSchema: compactMcpSchema(z.strictObject({
            boardId: z.string().min(1).max(128).describe("来源画板"),
            targetBoardId: z.string().min(1).max(128).optional(),
            elementIds: z.array(z.string().min(1).max(128)).min(1).max(1_000),
            dx: z.number().finite().min(-1_000_000).max(1_000_000).default(20),
            dy: z.number().finite().min(-1_000_000).max(1_000_000).default(20),
            externalBindings: z.enum(["detach", "preserve"]).default("detach"),
            expectedRevision: expectedRevisionSchema.describe("目标画板的读取时修订号；同板复制也使用此字段"),
            sourceExpectedRevision: expectedRevisionSchema.describe("跨板复制时可校验来源画板修订号"),
            responseMode: responseModeSchema,
          })),
          annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
        }, safeTool(async ({ boardId, targetBoardId = boardId, elementIds, dx, dy, externalBindings, expectedRevision, sourceExpectedRevision, responseMode }) => {
          if (targetBoardId !== boardId && externalBindings === "preserve")
            throw new HttpError(400, "INVALID_COPY_BINDING", "跨画板复制不能保留选择集外绑定，请使用 externalBindings=detach");
          const source = await api<SceneData>(`/api/scenes/${encodeURIComponent(boardId)}`, "GET");
          assertRevision(source, sourceExpectedRevision);
          const target = targetBoardId === boardId ? source
            : await api<SceneData>(`/api/scenes/${encodeURIComponent(targetBoardId)}`, "GET");
          assertRevision(target, expectedRevision);
          const { copied, created, merged } = measureMcpPhase("transformMs", () => {
            const copied = copyDrawingSelection(source.elements, elementIds, target.elements, dx, dy, externalBindings === "preserve");
            const batch = createDrawingBatch(copied.elements, target.elements);
            return { copied, created: batch.created, merged: batch.elements };
          });
          const overlaps = inspectDrawingOverlaps(target.elements, merged, copied.elements.map((element) => element.id!));
          const saved = await api<{ revision: number }>(`/api/scenes/${encodeURIComponent(targetBoardId)}`, "PUT", {
            baseRevision: target.revision, elements: merged, appState: target.appState,
          });
          return result({ boardId: targetBoardId, sourceBoardId: boardId, revision: saved.revision,
            elementCount: merged.length, ...drawingReceipt(created, responseMode), idMap: copied.idMap, groupIdMap: copied.groupIdMap,
            ...overlaps, warnings: [...copied.warnings, ...overlaps.warnings], url: boardUrl(targetBoardId) });
        }, "copy_elements"));

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
            const { elements, ...removal } = measureMcpPhase("transformMs", () => removeDrawingElements(
              current.elements,
              elementIds,
            ));
            if (!removal.removedCount) {
              return result({ boardId, ...removal, elementCount: elements.length, revision: current.revision, noop: true });
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
            return result({ boardId, ...removal, elementCount: elements.length, revision: saved.revision });
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
              updates: z.array(elementUpdateSchema).min(1).max(1_000).optional()
                .describe("修改对象数组 [{id,...}]，单个修改可用 update_element.update；新增用 elements，可在同次添加后更新该新 ID"),
              responseMode: responseModeSchema,
              name: z.string().trim().min(1).max(120).optional(),
              autoBind: autoBindSchema,
              backgroundColor: colorSchema.optional(),
              ...boardMetadataSchema,
            }).strict()),
            annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
          },
          safeTool(async ({ boardId, expectedRevision, elements, removeElementIds, updates, name, backgroundColor, folderId, folderName, tags, favorite, responseMode, autoBind }) => {
            if (!elements && !removeElementIds && !updates && name === undefined && backgroundColor === undefined &&
                folderId === undefined && folderName === undefined && tags === undefined && favorite === undefined) {
              throw new HttpError(400, "EMPTY_UPDATE", "请提供图元修改或画板元数据中至少一项。");
            }
            const current = await api<SceneData>(`/api/scenes/${encodeURIComponent(boardId)}`, "GET");
            assertRevision(current, expectedRevision);
            const { remaining, created, updated, autoBinding } = measureMcpPhase("transformMs", () => {
              const remaining = removeDrawingElements(current.elements, removeElementIds || []);
              const { created, elements: merged } = createDrawingBatch(elements || [], remaining.elements);
              const updated = updateDrawingElements(merged, updates || []);
              const attached = bindCreated({ created, elements: updated.elements }, autoBind);
              return { remaining, created: attached.created, updated: { ...updated, elements: attached.elements }, autoBinding: attached.autoBinding };
            });
            if (!remaining.removedCount && !created.length && !updated.updatedCount && name === undefined &&
                backgroundColor === undefined && folderId === undefined && folderName === undefined &&
                tags === undefined && favorite === undefined) {
              return result({ boardId, revision: current.revision, elementCount: current.elements.length,
                ...drawingReceipt(created, responseMode), removedCount: 0, requestedRemovedCount: remaining.requestedRemovedCount,
                cascadeRemovedCount: remaining.cascadeRemovedCount, notFoundIds: remaining.notFoundIds,
                updatedCount: 0, noop: true, url: boardUrl(boardId) });
            }
            const resolvedFolder = await resolveFolder({ folderId, folderName }, api);
            const changedIds = [...created.map((element) => element.id), ...(updates || []).map((update) => update.id)];
            const overlaps = changedIds.length ? inspectDrawingOverlaps(current.elements, updated.elements, changedIds) : {};
            const saved = await api<{ revision: number }>(`/api/scenes/${encodeURIComponent(boardId)}`, "PUT", {
              baseRevision: current.revision,
              ...(name === undefined ? {} : { name }),
              elements: updated.elements,
              appState: { ...current.appState, ...(backgroundColor === undefined ? {} : { viewBackgroundColor: backgroundColor }) },
              ...(resolvedFolder === undefined ? {} : { folder_id: resolvedFolder }), tags, favorite,
            });
            return result({ boardId, revision: saved.revision, elementCount: updated.elements.length, ...drawingReceipt(created, responseMode),
              removedCount: remaining.removedCount, requestedRemovedCount: remaining.requestedRemovedCount,
              cascadeRemovedCount: remaining.cascadeRemovedCount, notFoundIds: remaining.notFoundIds, updatedCount: updated.updatedCount,
              ...(autoBinding ? { autoBinding } : {}),
              ...overlaps, url: boardUrl(boardId) });
          }, "update_board"),
        );

        server.registerTool("update_element", {
          title: "原地修改图元",
          description: "输入{boardId,update:{id,...}}，按update.id原地修改，保留ID/连接/其余字段；dx/dy相对移动且标签/箭头跟随，回传最终x/y/width/height及绑定标签label几何。type仅核对已有类型，labelStyle只改标签样式。已有labelId仅核对，不能改名；新建标签可同时传text/labelId。批量用update_board.updates:[{id,...}]一次保存；高比例重叠仅给warnings。",
          inputSchema: compactMcpSchema(z.strictObject({
            boardId: z.string().min(1).max(128),
            update: elementUpdateSchema.describe("单个修改对象 {id,...}，例如 {id:'node',dx:100}；批量时将这些对象放入 update_board.updates 数组"),
            expectedRevision: expectedRevisionSchema,
          })),
          annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
        }, safeTool(async ({ boardId, update, expectedRevision }) => {
          const current = await api<SceneData>(`/api/scenes/${encodeURIComponent(boardId)}`, "GET");
          assertRevision(current, expectedRevision);
          const updated = measureMcpPhase("transformMs", () => updateDrawingElements(current.elements, [update]));
          if (!updated.updatedCount) {
            return result({ boardId, revision: current.revision, updatedCount: 0,
              ...positionReceipt(updated.elements, update.id), noop: true });
          }
          const overlaps = inspectDrawingOverlaps(current.elements, updated.elements, [update.id]);
          const saved = await api<{ revision: number }>(`/api/scenes/${encodeURIComponent(boardId)}`, "PUT", {
            baseRevision: current.revision, elements: updated.elements, appState: current.appState,
          });
          return result({ boardId, revision: saved.revision, updatedCount: updated.updatedCount,
            ...positionReceipt(updated.elements, update.id), ...overlaps, url: boardUrl(boardId) });
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
          const boards: Record<string, unknown>[] = boardIds.map((boardId) => ({ ok: false, boardId, truncated: true,
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
              boards[index] = { ok: true, ...await readBoard({ boardId, view, maxChars: available }) };
            } catch (error) {
              if (!(error instanceof HttpError)) throw error;
              const outcome = { ok: false, boardId, ...(error.code === "READ_BUDGET_TOO_SMALL" ? { truncated: true } : {}),
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
            "Accept, Authorization, Content-Type, Last-Event-Id, Mcp-Method, Mcp-Name, Mcp-Protocol-Version, Mcp-Session-Id, X-MCP-Token",
          "Access-Control-Max-Age": "600",
        });
        const origin = req.headers.get("origin");
        if (origin && runtime.config.corsOrigins.has(origin)) {
          headers.set("Access-Control-Allow-Origin", origin);
          headers.set("Vary", "Origin");
        }
        return response(runtime, req, null, { status: 204, headers });
      }

      const providedToken = getPathToken(req);
      const providedHash = new Uint8Array(
        new Bun.CryptoHasher("sha256").update(providedToken).digest(),
      );
      const expectedHash = new Uint8Array(
        new Bun.CryptoHasher("sha256").update(expectedToken).digest(),
      );
      if (!timingSafeEqual(providedHash, expectedHash) || providedToken !== expectedToken) {
        return jsonResponse(
          runtime,
          req,
          { error: "MCP 授权令牌无效或缺失", code: "MCP_UNAUTHORIZED" },
          401,
        );
      }

      const releaseBodyRequestSlot = req.body
        ? await requestBodyLimiter.acquire(req.signal)
        : null;
      let reservedBytes = 0;
      try {
        if (req.body) {
          reservedBytes = await runtime.bodyMemoryBudget.acquire(
            runtime.config.maxSceneBodyBytes,
            req.signal,
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
      } finally {
        if (reservedBytes > 0) {
          runtime.bodyMemoryBudget.release(reservedBytes);
        }
        releaseBodyRequestSlot?.();
      }
    },
    close: async () => {
      if (internalSessionToken) {
        unregisterMcpCreateSession(runtime, internalSessionToken);
      }
      await mcp?.close();
    },
  };
};
