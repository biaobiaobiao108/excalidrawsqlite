import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  colorSchema, drawingElementSchema, createDrawingBatch, removeDrawingElements,
  compactElement, elementUpdateSchema, updateDrawingElements, inputDrawingElements,
} from "./mcp-drawing";
import { compactDrawingElements } from "./mcp-read";
import { copyDrawingSelection } from "./mcp-copy";
import { inspectDrawingOverlaps } from "./mcp-overlap";
import { registerManagementTools, resolveFolder } from "./mcp-management";
import { measureMcpApi, measureMcpPhase, traceMcpTool } from "./mcp-trace";
import { compactMcpSchema } from "./mcp-schema";
import { buildDiagram, diagramSchema } from "./mcp-diagram";

import { randomBase64Url, timingSafeEqual } from "./crypto";
import { HttpError } from "./errors";
import { getRequestOrigin, isAllowedOrigin, jsonResponse, response } from "./http";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ServerRuntime } from "./types";

export const MCP_PATH = "/mcp";

const getMcpServerInstructions = (runtime: ServerRuntime) => [
  "Excalidraw 白板支持搜索、读取及批量绘制。流程图/时间线优先 create_diagram 一次传 nodes/edges 自动排版；自定义绘图用 create_board 一次传入名称和全部 elements，不要先建空板再逐个绘制。",
  "每次最多 1,000 个图元描述；形状 text 自动绑定文字。可给节点指定 id，箭头仅传 startBinding/endBinding.elementId 即自动连接同批或已有节点；自连接或同中心节点须显式坐标。折线 points 使用绝对画布坐标；二点仍可用 startX/startY/endX/endY。字段严格校验，不能输入原始内部字段。",
  "独立 text 可传 width 固定宽度并自动换行，height 始终按内容计算，不传 height；省略 width 默认自动宽度。更新 width 会保持固定宽度，更新 autoResize=true 恢复自动宽度；绑定标签尺寸请修改所属形状。",
  "需要无箭头且随节点移动的连线，使用 arrow + endArrowhead:null（默认 startArrowhead 为 null）；line 为固定坐标线段，不支持绑定。create_diagram.edges 也可传 endArrowhead:null，适合思维导图/组织结构。",
  "修改优先 update_board 一次合并添加、removeElementIds、updates 原地修改及元数据；只改一个图元用 update_element，保留 ID 和绑定。dx/dy 可相对平移，无需读取坐标，同轴不与 x/y 或折线坐标混用。expectedRevision 是可选的已读修订号，服务端始终使用乐观锁；冲突后重新判断，禁止盲目重试。",
  "get_board.input 返回可写描述，elements 可直接用于 update_board.updates，type 仅核对类型；不能直接追加已有 ID。复制优先 copy_elements：选 ID 自动换新 ID、平移、重连内部箭头，返回 idMap；targetBoardId 省略为同板，跨板外部绑定必须解绑。绑定文字合并到形状，标签 ID 筛选返回本体，points 是绝对坐标，rotation 是度。truncated/nextOffset 表示分页或预算截断；input 的 unsupportedElementIds/warnings 表示投影省略，不能视为空板。常规阅读使用 compact；full 仅调试或小批量检查，包含原生内部字段且 points 是相对坐标。",
  "create_board 可同时设置 folderId/folderName、favorite、tags；folderName 会幂等获取或创建文件夹，重名歧义报错。文件夹用 list/ensure/create/update/delete_folder。manage_board 一次管理收藏、标签、移动和改名，batch_manage_boards 批量管理逐条返回结果。",
  `delete_board 只软删除，restore_board 还原；MCP 不提供永久删除或清空回收站。${runtime.config.trashRetentionDays === 0 ? "当前回收站自动清理已禁用。" : `当前回收站保留 ${runtime.config.trashRetentionDays} 天，超期后由定期维护自动清理。`}delete_folder 仅移画板至根目录，正式执行需 confirm=true，可先 dryRun 查看影响。`,
  "完整业务结果位于 structuredContent，成功 text 仅给简短说明，不重复数据。检查 ok 与 error.code；schema 拒绝可能只有 isError=true 和 text，客户端也必须读取该错误。画板标识统一 boardId，元数据使用 elementCount/folderId/folderName/createdAt/updatedAt/lastOpenedAt/deletedAt。图元和文件夹仍使用 id。绘图写工具默认 responseMode=minimal 仅回数量/修订号/URL；copy_elements 始终额外返回 idMap/warnings。需要自动 ID 时设 ids 返回 elementMap（inputIndex 对应本体与 labelId）、requestedElementIds（本体）、generatedElementIds（附属文字）。addedCount 是实际新建图元数，elementCount 是全板当前图元数。批读每项有 ok，partial 表示成功失败混合，truncated 仅表示内容/预算截断。",
  "list_boards.view=recent 只列打开过的画板，默认按 lastOpenedAt 倒序；view=all,sort=opened 则包含从未打开的画板并置于末尾。create_diagram 的边 ID 默认 diagram_edge_<从0起序号>，与节点ID冲突时加后缀；准确映射用 responseMode=ids 的 elementMap，后续可用 update_element 改箭头样式。remove_elements/update_board 回传 notFoundIds，removedCount 包含级联删除，cascadeRemovedCount 是未显式请求的附属删除数。",
  "update_element 输入 {boardId,update:{id,...}}，update_board 使用 {boardId,updates:[{id,...}]}；新增放 elements，可与 updates 同次提交，先新增再修改。update_element 回传最终 x/y/width/height 和现有绑定标签 label 几何。图元读取的 elementCount 是含标签的原生总数，viewElementCount 是当前视图筛选前总数，matchedCount 是筛选匹配数，returnedElementCount 是本页数。移动/复制的 ELEMENT_OVERLAP warnings 为高比例旋转外接框重叠提示，不阻止保存；检查有容量上限，overlapCheck.complete=false 表示未完成，不能把没有提示视为保证不重叠。",
  "REST /api/scenes 使用原生 Excalidraw 图元；MCP 使用简化绘图描述，禁止混用两种格式。可在同一画板使用两条通道编辑，但每次应基于最新修订号增量合并，不能用投影覆盖原生场景，已有图片/自由画笔在 MCP 增量更新中会保留。maxChars 限制业务结果的字符预算；分页不意味着按页读取存储，极大画板优先 summary 和筛选。",
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

const result = (value: Record<string, unknown>) => measureMcpPhase("responseBuildMs", () => {
  const structuredContent = { ok: !value.error, ...cleanBoardRecord(value),
    ...Object.fromEntries(["items", "boards", "results", "folders"].filter((key) => Array.isArray(value[key]))
      .map((key) => [key, (value[key] as Record<string, unknown>[]).map(cleanBoardRecord)])),
    ...(value.folder && typeof value.folder === "object"
      ? { folder: cleanBoardRecord(value.folder as Record<string, unknown>) } : {}),
  };
  return { structuredContent, content: [{ type: "text" as const, text: value.error
    ? `操作失败：${(value.error as { message: string }).message}`
    : "操作成功；详情见 structuredContent。" }] };
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

const createInternalApi = (apiHandler: ApiHandler, sessionToken: string) =>
  async <T>(path: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown) => measureMcpApi(method, async () => {
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
  });

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
          { maxToolInputElements: 100_000, instructions: getMcpServerInstructions(runtime) },
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
          return { ...metadata, elements, returnedElementCount: elements.length,
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
            description: "默认 compact 只读视图保留文字、几何、连接，标签折入本体且省略装饰样式；elements 含样式；input 返回可直接用于 update_board.updates 的描述，type 仅核对类型，已有 ID 不能追加；复制优先 copy_elements。input/紧凑视图按标签 ID 筛选返回本体。truncated/nextOffset 表示分页截断；仅 input 返回 unsupportedElementIds/warnings 表示无法可写投影，省略图元不代表空板。input/紧凑 points 绝对坐标，full 相对坐标。",
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
          description: "一次传节点标题/正文与连接，自动排版并创建画板，无需计算坐标。最多100节点/200连接，默认纵向流程图与forest主题；省略edges按顺序连接，[]不连线，edges.endArrowhead=null为无箭头连接。节点id可直接用于后续更新。复杂自定义图元用create_board。",
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
            elementCount: merged.length, ...drawingReceipt(created, responseMode), idMap: copied.idMap,
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
