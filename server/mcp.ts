import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  colorSchema,
  compactElement,
  drawingElementSchema,
  createDrawingBatch,
  inputDrawingElements,
  measureDrawingText,
} from "./mcp-drawing";
import { compactDrawingElements } from "./mcp-read";
import { registerElementTools } from "./mcp-tools-elements";
import {
  getSceneFolderFields,
  registerManagementTools,
} from "./mcp-management";
import { measureMcpPhase } from "./mcp-trace";
import {
  drawingReceipt,
  mcpError,
  positionReceipt,
  projectMcpRecord,
  responseModeSchema,
  result as buildMcpResult,
} from "./mcp-response";
import {
  createInternalApi,
  createRequestBodyLimiter,
  type ApiHandler,
} from "./mcp-internal-api";
import { compactMcpSchema } from "./mcp-schema";
import { buildDiagram, diagramSchema } from "./mcp-diagram";
import {
  measureTextSchema,
  layoutSchema,
  buildDrawingLayout,
} from "./mcp-layout";
import {
  registerMcpCreateSession,
  unregisterMcpCreateSession,
  lookupMcpCreateReplay,
} from "./create-idempotency";
import { inspectLayout, inspectLayoutSchema } from "./mcp-inspect";
import {
  buildMarkdownMindmapScene,
  buildMermaidScene,
  offsetDiagramElements,
} from "./mcp-text-diagrams";

import { randomBase64Url, timingSafeEqual } from "./crypto";
import {
  consumeRateLimit,
  getClientKey,
  registerInternalSession,
  unregisterInternalSession,
} from "./auth";
import { AUTH_RATE_WINDOW_MS } from "./config";
import { HttpError } from "./errors";
import { isAllowedOrigin, jsonResponse, response } from "./http";
import {
  MCP_PATH,
  assertRevision,
  autoBindSchema,
  bindCreated,
  boardMetadataSchema,
  createIntent,
  expectedRevisionSchema,
  getMcpServerInstructions,
  getPathToken,
  idempotencyKeySchema,
  makeSafeTool,
  type McpRequestHandler,
  type SceneData,
} from "./mcp-helpers";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { RequestAddressResolver, ServerRuntime } from "./types";

export { MCP_PATH };

export const createMcpRequestHandler = (
  runtime: ServerRuntime,
  apiHandler: ApiHandler,
  requestAddressResolver?: RequestAddressResolver,
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
    registerInternalSession(runtime, internalSessionToken);
  }

  const api = internalSessionToken
    ? createInternalApi(apiHandler, internalSessionToken)
    : null;
  const folderExists = api
    ? runtime.db.query("SELECT id FROM folders WHERE id = ?")
    : null;

  const mcp =
    expectedToken && api
      ? createMcpHandler(
          () => {
            const server = new McpServer(
              { name: "excalidrawsqlite", version: "1.0.0" },
              {
                maxToolInputElements: 100_000,
                instructions: getMcpServerInstructions(runtime),
              },
            );
            const safeTool = <T>(
              handler: (args: T) => Promise<ReturnType<typeof buildMcpResult>>,
              operation: string,
            ) => makeSafeTool(handler, runtime.config.mcpTrace, operation);
            const { publicOrigin } = runtime.config;
            const result = (value: Record<string, unknown>) =>
              buildMcpResult(value, publicOrigin);
            const replayReceipt = (board: Record<string, unknown>) =>
              result({
                ...board,
                addedCount: 0,
                idempotentReplay: true,
              });
            const creationReplay = (key: string | undefined, intent: unknown) =>
              lookupMcpCreateReplay(runtime, key, intent);

            const readBoard = async ({
              boardId,
              view = "compact",
              elementIds,
              query,
              type,
              offset = 0,
              limit = 1_000,
              maxChars = 1_000_000,
            }: {
              boardId: string;
              view?: "summary" | "compact" | "elements" | "full" | "input";
              elementIds?: string[];
              query?: string;
              type?: string;
              offset?: number;
              limit?: number;
              maxChars?: number;
            }) => {
              if (view === "summary") {
                if (elementIds || query || type || offset) {
                  throw new HttpError(
                    400,
                    "INVALID_ARGUMENT",
                    "summary 不读取图元，请省略图元筛选与 offset。",
                  );
                }
                const summary = await api<Record<string, unknown>>(
                  `/api/scenes/${encodeURIComponent(boardId)}/summary`,
                  "GET",
                );
                const value = projectMcpRecord(summary, publicOrigin);
                if (JSON.stringify(value).length + 64 > maxChars) {
                  throw new HttpError(
                    400,
                    "READ_BUDGET_TOO_SMALL",
                    "画板摘要超过字符预算，请增加 maxChars。",
                  );
                }
                return value;
              }
              const board = await api<SceneData>(
                `/api/scenes/${encodeURIComponent(boardId)}`,
                "GET",
              );
              const { writable, compact } = measureMcpPhase(
                "transformMs",
                () => ({
                  writable:
                    view === "input"
                      ? inputDrawingElements(board.elements)
                      : null,
                  compact:
                    view === "compact"
                      ? compactDrawingElements(board.elements)
                      : null,
                }),
              );
              // Semantic/input views collapse attached text before filtering/pagination.
              const source = (compact?.elements ||
                writable?.elements ||
                board.elements) as unknown as ExcalidrawElement[];
              const labelOwners = compact?.labelOwners || writable?.labelOwners;
              const selected = elementIds
                ? new Set(elementIds.map((id) => labelOwners?.get(id) || id))
                : null;
              const needle = query?.toLocaleLowerCase();
              const matches = source.filter(
                (element) =>
                  (!selected || selected.has(element.id)) &&
                  (!type || element.type === type) &&
                  (!needle ||
                    ("text" in element &&
                      typeof element.text === "string" &&
                      element.text.toLocaleLowerCase().includes(needle))),
              );
              const base = projectMcpRecord(
                {
                  ...(view === "full"
                    ? board
                    : {
                        boardId: board.id,
                        name: board.name,
                        revision: board.revision,
                      }),
                  elementCount: board.elements.length,
                  elements: [],
                },
                publicOrigin,
              );
              const allIds = selected
                ? new Set([
                    ...source.map((element) => element.id),
                    ...(labelOwners?.keys() || []),
                  ])
                : null;
              const metadata = {
                ...base,
                viewElementCount: source.length,
                returnedElementCount: 0,
                matchedCount: matches.length,
                nextOffset: null,
                truncated: false,
                pointCoordinateSystem: "relative",
                ...(writable
                  ? {
                      unsupportedElementIds: writable.unsupportedElementIds,
                      warnings: writable.warnings,
                    }
                  : {}),
                ...(writable
                  ? { elementGeometry: [] as Record<string, unknown>[] }
                  : {}),
                ...(selected
                  ? {
                      notFoundIds: elementIds!.filter((id) => !allIds!.has(id)),
                    }
                  : {}),
              };
              // Budget is charged per element rather than serializing another complete scene.
              // Reserve digits for the pagination offset and the outer structured result.
              let chars = JSON.stringify(metadata).length + 64;
              if (chars > maxChars) {
                throw new HttpError(
                  400,
                  "READ_BUDGET_TOO_SMALL",
                  "画板元数据超过字符预算，请增加 maxChars 或使用 elements/summary。",
                );
              }
              const elements: Record<string, unknown>[] = [];
              const elementGeometry: Record<string, unknown>[] = [];
              const nativeElements = writable
                ? new Map(
                    board.elements.map((element) => [element.id, element]),
                  )
                : null;
              let index = offset;
              while (index < matches.length && elements.length < limit) {
                const current = matches[index];
                const element =
                  view === "full" || view === "input" || view === "compact"
                    ? current
                    : {
                        ...compactElement(current),
                        ...(current.type === "arrow" || current.type === "line"
                          ? { points: current.points }
                          : {}),
                      };
                const native = nativeElements?.get(current.id);
                const geometry =
                  native?.type === "text"
                    ? {
                        elementId: native.id,
                        height: native.height,
                        lineHeight: native.lineHeight,
                        lineHeightPx: native.fontSize * native.lineHeight,
                        lineCount: native.text.split("\n").length,
                      }
                    : null;
                const cost =
                  JSON.stringify(element).length +
                  1 +
                  (geometry ? JSON.stringify(geometry).length + 1 : 0);
                if (chars + cost > maxChars) break;
                chars += cost;
                elements.push(element as unknown as Record<string, unknown>);
                if (geometry) elementGeometry.push(geometry);
                index++;
              }
              if (index === offset && index < matches.length) {
                throw new HttpError(
                  400,
                  "READ_BUDGET_TOO_SMALL",
                  `图元 ${matches[index].id} 超过字符预算；请增加 maxChars 或改用 elements。`,
                );
              }
              return {
                ...metadata,
                elements,
                ...(writable ? { elementGeometry } : {}),
                returnedElementCount: elements.length,
                nextOffset: index < matches.length ? index : null,
                truncated: index < matches.length,
              };
            };

            server.registerTool(
              "list_boards",
              {
                title: "列出画板",
                description:
                  "搜索画板摘要；支持文件夹、收藏、精确标签、最近打开和回收站视图。query 匹配名称/标签/文件夹名；cursor 接续 nextCursor，不回传图元。trash 固定按删除时间倒序。",
                inputSchema: compactMcpSchema(
                  z
                    .object({
                      query: z.string().max(120).optional(),
                      limit: z.number().int().min(1).max(100).optional(),
                      cursor: z.string().max(2_000).optional(),
                      folderId: z
                        .string()
                        .min(1)
                        .max(128)
                        .nullable()
                        .optional()
                        .describe("null 仅根目录；省略则不限目录"),
                      favorite: z
                        .boolean()
                        .optional()
                        .describe(
                          "唯一的收藏筛选：true 仅收藏，false 仅未收藏，省略不限",
                        ),
                      tag: z.string().trim().min(1).max(32).optional(),
                      view: z.enum(["all", "recent", "trash"]).optional(),
                      sort: z.enum(["updated", "created", "opened"]).optional(),
                    })
                    .strict(),
                ),
                annotations: {
                  readOnlyHint: true,
                  idempotentHint: true,
                  openWorldHint: false,
                },
              },
              safeTool(
                async ({
                  query,
                  limit,
                  cursor,
                  folderId,
                  favorite,
                  tag,
                  view = "all",
                  sort,
                }) => {
                  if (folderId && !folderExists!.get(folderId)) {
                    throw new HttpError(
                      404,
                      "FOLDER_NOT_FOUND",
                      "文件夹不存在，请使用 list_folders 确认 ID。",
                    );
                  }
                  if (view === "trash" && sort && sort !== "updated") {
                    throw new HttpError(
                      400,
                      "INVALID_ARGUMENT",
                      "trash 视图固定按删除时间倒序，请省略 sort。",
                    );
                  }
                  const params = new URLSearchParams({
                    limit: String(limit || 50),
                  });
                  if (query?.trim()) params.set("q", query.trim());
                  if (cursor) params.set("cursor", cursor);
                  if (folderId !== undefined)
                    params.set("folder_id", folderId || "");
                  if (favorite !== undefined)
                    params.set("favorite", String(favorite));
                  if (tag) params.set("tag", tag);
                  if (view === "recent") params.set("opened", "true");
                  if (sort || view === "recent")
                    params.set("sort", sort || "opened");
                  const boards = await api<Record<string, unknown>>(
                    `/api/scenes${view === "trash" ? "/trash" : ""}?${params.toString()}`,
                    "GET",
                  );
                  return result(boards);
                },
                "list_boards",
              ),
            );

            server.registerTool(
              "get_board",
              {
                title: "读取画板",
                description:
                  "默认 compact 只读视图保留文字、几何、连接，标签折入本体且省略装饰样式；elements 含样式；input 返回可直接用于 update_board.updates 的描述，type 仅核对类型，已有 ID 不能追加；复制优先 copy_elements。input/紧凑视图按标签 ID 筛选返回本体。truncated/nextOffset 表示分页截断；仅 input 返回 unsupportedElementIds/warnings 表示无法可写投影，省略图元不代表空板。所有视图的 points 均相对图元 x/y 原点。",
                inputSchema: compactMcpSchema(
                  z
                    .object({
                      boardId: z.string().min(1).max(128),
                      view: z
                        .enum([
                          "summary",
                          "compact",
                          "elements",
                          "full",
                          "input",
                        ])
                        .optional()
                        .describe(
                          "input.elements 可直接写回，文字只读高度/行高在同页 elementGeometry，勿合并进 updates；其他视图用于阅读",
                        ),
                      elementIds: z
                        .array(z.string().min(1).max(128))
                        .min(1)
                        .max(1_000)
                        .optional(),
                      query: z
                        .string()
                        .trim()
                        .min(1)
                        .max(120)
                        .optional()
                        .describe(
                          "搜索文字；compact/input 匹配合并后的标签，type 筛选合并后的本体类型；elements/full 匹配独立文字",
                        ),
                      type: z
                        .enum([
                          "rectangle",
                          "ellipse",
                          "diamond",
                          "text",
                          "line",
                          "arrow",
                          "image",
                          "freedraw",
                          "frame",
                          "magicframe",
                          "embeddable",
                          "iframe",
                        ])
                        .optional(),
                      offset: z.number().int().min(0).optional(),
                      limit: z.number().int().min(1).max(1_000).optional(),
                      maxChars: z
                        .number()
                        .int()
                        .min(1_000)
                        .max(2_000_000)
                        .optional()
                        .describe("图元与元数据总字符预算，默认1,000,000"),
                    })
                    .strict(),
                ),
                annotations: {
                  readOnlyHint: true,
                  idempotentHint: true,
                  openWorldHint: false,
                },
              },
              safeTool(
                async (args) => result(await readBoard(args)),
                "get_board",
              ),
            );

            server.registerTool(
              "inspect_layout",
              {
                title: "检查画板几何布局",
                description:
                  "只读检查文字重叠、容器内文字溢出、可能的元素碰撞和已绑定箭头连接异常。默认检查全部四项，可用 checks 筛选。使用现有图元尺寸，无浏览器或字体像素测量；正常包含、装饰箭头和无限画布负坐标不视为错误。不自动修改；根据 issues.elementIds 调用 update_board 后复查。complete=false 表示预算截断，未发现问题不保证视觉正确。",
                inputSchema: compactMcpSchema(
                  inspectLayoutSchema.extend({
                    boardId: z.string().min(1).max(128),
                  }),
                ),
                annotations: {
                  readOnlyHint: true,
                  destructiveHint: false,
                  idempotentHint: true,
                  openWorldHint: false,
                },
              },
              safeTool(async ({ boardId, checks, inferTextContainers }) => {
                const current = await api<SceneData>(
                  `/api/scenes/${encodeURIComponent(boardId)}`,
                  "GET",
                );
                return result({
                  boardId,
                  revision: current.revision,
                  ...measureMcpPhase("transformMs", () =>
                    inspectLayout(current.elements, {
                      checks,
                      inferTextContainers,
                    }),
                  ),
                });
              }, "inspect_layout"),
            );

            server.registerTool(
              "measure_text",
              {
                title: "估算文字换行与尺寸",
                description:
                  "创建前估算文字自然宽度或固定 width 下的换行、宽高；与 MCP 创建文字使用相同服务端估算器，不读取或修改画板。中文和其他字符采用估算宽度，字体实际效果请预览复查。",
                inputSchema: compactMcpSchema(measureTextSchema),
                annotations: {
                  readOnlyHint: true,
                  destructiveHint: false,
                  idempotentHint: true,
                  openWorldHint: false,
                },
              },
              safeTool(
                async (args) =>
                  result(
                    measureMcpPhase("transformMs", () =>
                      measureDrawingText(args),
                    ),
                  ),
                "measure_text",
              ),
            );

            server.registerTool(
              "create_layout",
              {
                title: "自动创建卡片网格画板",
                description:
                  "一次传入最多100张 cards（title/body），自动换行、测高和分列，无需逐个计算坐标。每张背景、标题、正文共享原生分组，编辑器可整体拖动；cards.elementIds 可用于 MCP 批量移动/复制，MCP 按指定 ID 操作。mode 当前支持 grid。返回卡片及布局边界；文字尺寸是服务端估算，创建后可用 inspect_layout 复查。",
                inputSchema: compactMcpSchema(
                  layoutSchema.safeExtend({
                    name: z.string().trim().min(1).max(120),
                    ...boardMetadataSchema,
                    responseMode: responseModeSchema,
                    idempotencyKey: idempotencyKeySchema,
                  }),
                ),
                annotations: {
                  destructiveHint: false,
                  idempotentHint: false,
                  openWorldHint: false,
                },
              },
              safeTool(async (args) => {
                const intent = createIntent("create_layout", args);
                const replay = creationReplay(args.idempotencyKey, intent);
                if (replay) return replayReceipt(replay);
                const { layout, drawing } = measureMcpPhase(
                  "transformMs",
                  () => {
                    const layout = buildDrawingLayout(args);
                    return {
                      layout,
                      drawing: createDrawingBatch(layout.elements),
                    };
                  },
                );
                const folder = getSceneFolderFields(args, runtime);
                const board = await api<{
                  id: string;
                  name: string;
                  revision: number;
                  idempotentReplay?: boolean;
                }>("/api/scenes", "POST", {
                  name: args.name,
                  elements: drawing.elements,
                  appState: { viewBackgroundColor: "#ffffff" },
                  ...folder,
                  tags: args.tags,
                  favorite: args.favorite,
                  ...(args.idempotencyKey
                    ? {
                        idempotencyKey: args.idempotencyKey,
                        idempotencyPayload: intent,
                      }
                    : {}),
                });
                if (board.idempotentReplay) return replayReceipt(board);
                return result({
                  boardId: board.id,
                  name: board.name,
                  revision: board.revision,
                  elementCount: drawing.elements.length,
                  ...drawingReceipt(drawing.created, args.responseMode),
                  cards: layout.cards,
                  bounds: layout.bounds,
                  estimated: layout.estimated,
                  note: layout.note,
                });
              }, "create_layout"),
            );

            server.registerTool(
              "create_board",
              {
                title: "创建画板",
                description:
                  "一次创建画板并绘制全部内容。普通绘图直接传完整 elements，最多 1,000 个描述；省略 elements 创建空板。允许同名，不会覆盖已有画板。",
                inputSchema: compactMcpSchema(
                  z
                    .object({
                      name: z.string().trim().min(1).max(120),
                      elements: z
                        .array(drawingElementSchema)
                        .max(1_000)
                        .optional(),
                      backgroundColor: colorSchema
                        .optional()
                        .describe("画布背景颜色，默认白色"),
                      responseMode: responseModeSchema,
                      idempotencyKey: idempotencyKeySchema,
                      autoBind: autoBindSchema,
                      ...boardMetadataSchema,
                    })
                    .strict(),
                ),
                annotations: {
                  destructiveHint: false,
                  idempotentHint: false,
                  openWorldHint: false,
                },
              },
              safeTool(async (args) => {
                const {
                  name,
                  elements = [],
                  backgroundColor,
                  folderId,
                  folderName,
                  tags,
                  favorite,
                  responseMode,
                  idempotencyKey,
                  autoBind,
                } = args;
                const intent = createIntent("create_board", args);
                const replay = creationReplay(idempotencyKey, intent);
                if (replay) return replayReceipt(replay);
                const {
                  elements: drawing,
                  created,
                  autoBinding,
                } = measureMcpPhase("transformMs", () =>
                  bindCreated(createDrawingBatch(elements), autoBind),
                );
                const folder = getSceneFolderFields(
                  { folderId, folderName },
                  runtime,
                );
                const board = await api<{
                  id: string;
                  name: string;
                  revision: number;
                  idempotentReplay?: boolean;
                }>("/api/scenes", "POST", {
                  name,
                  elements: drawing,
                  appState: {
                    viewBackgroundColor: backgroundColor || "#ffffff",
                  },
                  ...folder,
                  tags,
                  favorite,
                  ...(idempotencyKey
                    ? { idempotencyKey, idempotencyPayload: intent }
                    : {}),
                });
                if (board.idempotentReplay) return replayReceipt(board);
                return result({
                  boardId: board.id,
                  name: board.name,
                  revision: board.revision,
                  elementCount: drawing.length,
                  ...drawingReceipt(created, responseMode),
                  ...(autoBinding ? { autoBinding } : {}),
                });
              }, "create_board"),
            );

            server.registerTool(
              "create_diagram",
              {
                title: "自动绘制流程、架构或泳道图",
                description:
                  "一次传节点标题/正文与连接自动排版。layout支持flowchart/timeline/architecture/swimlane，最多100节点/200连接/24区域。architecture区域最多两级，swimlane平级且默认横向；高级模式传regions与nodes.regionId，省略edges不连线，普通模式省略edges按顺序连接。edges.endArrowhead=null为无箭头绑定连接。返回区域ID/分组/节点归属/边界；文字尺寸为服务端估算，创建后inspect_layout复查。",
                inputSchema: compactMcpSchema(
                  diagramSchema.safeExtend({
                    ...boardMetadataSchema,
                    responseMode: responseModeSchema,
                    idempotencyKey: idempotencyKeySchema,
                  }),
                ),
                annotations: {
                  destructiveHint: false,
                  idempotentHint: false,
                  openWorldHint: false,
                },
              },
              safeTool(async (args) => {
                const intent = createIntent("create_diagram", args);
                const replay = creationReplay(args.idempotencyKey, intent);
                if (replay) return replayReceipt(replay);
                const { diagram, drawing } = measureMcpPhase(
                  "transformMs",
                  () => {
                    const diagram = buildDiagram(args);
                    return {
                      diagram,
                      drawing: createDrawingBatch(diagram.elements),
                    };
                  },
                );
                const folder = getSceneFolderFields(args, runtime);
                const board = await api<{
                  id: string;
                  name: string;
                  revision: number;
                  idempotentReplay?: boolean;
                }>("/api/scenes", "POST", {
                  name: args.name,
                  elements: drawing.elements,
                  appState: { viewBackgroundColor: "#ffffff" },
                  ...folder,
                  tags: args.tags,
                  favorite: args.favorite,
                  ...(args.idempotencyKey
                    ? {
                        idempotencyKey: args.idempotencyKey,
                        idempotencyPayload: intent,
                      }
                    : {}),
                });
                if (board.idempotentReplay) return replayReceipt(board);
                return result({
                  boardId: board.id,
                  name: board.name,
                  revision: board.revision,
                  nodeCount: diagram.nodeCount,
                  edgeCount: diagram.edgeCount,
                  layout: diagram.layout,
                  direction: diagram.direction,
                  theme: diagram.theme,
                  elementCount: drawing.elements.length,
                  ...("regions" in diagram
                    ? {
                        regions: diagram.regions,
                        bounds: diagram.bounds,
                        nodeRegions: diagram.nodeRegions,
                        estimated: diagram.estimated,
                      }
                    : {}),
                  ...drawingReceipt(drawing.created, args.responseMode),
                });
              }, "create_diagram"),
            );

            const uploadInternalFile = async (
              fileId: string,
              mimeType: string,
              bytes: Uint8Array<ArrayBuffer>,
            ): Promise<string> => {
              const req = new Request(
                `http://excalidraw-mcp.internal/api/files/${encodeURIComponent(fileId)}`,
                {
                  method: "PUT",
                  headers: {
                    Cookie: `excalidraw_session=${internalSessionToken}`,
                    "Content-Type": mimeType,
                  },
                  body: bytes,
                },
              );
              const res = await apiHandler(req);
              const payload = (await res.json().catch(() => null)) as {
                file?: { id?: string };
                code?: string;
                error?: string;
              } | null;
              if (!res.ok || !payload?.file?.id) {
                throw new HttpError(
                  res.status || 500,
                  payload?.code || "MCP_API_ERROR",
                  payload?.error || "上传 Mermaid 图像附件失败",
                );
              }
              return payload.file.id;
            };

            const persistTextDiagram = async ({
              args,
              generatedElements,
              defaultBgColor,
              toolName,
              extraResult,
            }: {
              args: {
                boardId?: string;
                expectedRevision?: number;
                name?: string;
                x?: number;
                y?: number;
                folderId?: string | null;
                folderName?: string;
                tags?: string[];
                favorite?: boolean;
                responseMode?: "minimal" | "ids";
                idempotencyKey?: string;
              };
              generatedElements: ExcalidrawElement[];
              defaultBgColor: string;
              toolName: string;
              extraResult?: Record<string, unknown>;
            }) => {
              const positioned = offsetDiagramElements(
                generatedElements,
                args.x ?? 0,
                args.y ?? 0,
              );
              if (args.boardId) {
                const board = await api<SceneData>(
                  `/api/scenes/${encodeURIComponent(args.boardId)}`,
                  "GET",
                );
                assertRevision(board, args.expectedRevision);
                const merged = [...board.elements, ...positioned];
                const saved = await api<{
                  id: string;
                  revision: number;
                  updated_at: number;
                }>(`/api/scenes/${encodeURIComponent(args.boardId)}`, "PUT", {
                  name: board.name,
                  elements: merged,
                  appState: board.appState,
                  baseRevision: board.revision,
                });
                return result({
                  boardId: saved.id,
                  name: board.name,
                  revision: saved.revision,
                  elementCount: merged.length,
                  ...extraResult,
                  ...drawingReceipt(positioned, args.responseMode),
                });
              }
              if (!args.name) {
                throw new HttpError(
                  400,
                  "INVALID_INPUT",
                  "新建画板时必须提供 name；若要追加到已有画板，请传 boardId",
                );
              }
              const intent = createIntent(toolName, args);
              const replay = creationReplay(args.idempotencyKey, intent);
              if (replay) return replayReceipt(replay);
              const folder = getSceneFolderFields(args, runtime);
              const board = await api<{
                id: string;
                name: string;
                revision: number;
                idempotentReplay?: boolean;
              }>("/api/scenes", "POST", {
                name: args.name,
                elements: positioned,
                appState: { viewBackgroundColor: defaultBgColor },
                ...folder,
                tags: args.tags,
                favorite: args.favorite,
                ...(args.idempotencyKey
                  ? {
                      idempotencyKey: args.idempotencyKey,
                      idempotencyPayload: intent,
                    }
                  : {}),
              });
              if (board.idempotentReplay) return replayReceipt(board);
              return result({
                boardId: board.id,
                name: board.name,
                revision: board.revision,
                elementCount: positioned.length,
                ...extraResult,
                ...drawingReceipt(positioned, args.responseMode),
              });
            };

            server.registerTool(
              "create_from_mermaid",
              {
                title: "通过 Mermaid 语法创建或追加图表",
                description:
                  '将 Mermaid 语法转换为 Excalidraw 图元。传 boardId 可直接追加到已有画板的 (x, y) 位置；不传 boardId 时新建画板（需传 name）。支持将流程图(flowchart/graph)、时序图(sequenceDiagram)、类图(classDiagram)、状态图(stateDiagram)、ER图(erDiagram)、甘特图(gantt)、象限图(quadrantChart)与时间线(timeline)转为原生可编辑图元；其余图表自动转为净化后的安全 SVG 图像附件。节点含中文、空格或括号等特殊字符时请用双引号包裹（如 A["用户登录 (OAuth)"]）。',
                inputSchema: compactMcpSchema(
                  z.object({
                    name: z
                      .string()
                      .trim()
                      .min(1)
                      .max(120)
                      .optional()
                      .describe("新建画板名称（不传 boardId 时必填）"),
                    boardId: z
                      .string()
                      .min(1)
                      .max(128)
                      .optional()
                      .describe("可选目标画板 ID；传入时追加到该画板而非新建"),
                    expectedRevision: expectedRevisionSchema,
                    x: z
                      .number()
                      .finite()
                      .optional()
                      .describe("图表左上角目标 X 坐标（默认 0）"),
                    y: z
                      .number()
                      .finite()
                      .optional()
                      .describe("图表左上角目标 Y 坐标（默认 0）"),
                    mermaid: z
                      .string()
                      .min(1)
                      .max(50_000)
                      .describe(
                        "Mermaid 图表定义文本；含中文/特殊字符的节点标签请加双引号",
                      ),
                    ...boardMetadataSchema,
                    responseMode: responseModeSchema,
                    idempotencyKey: idempotencyKeySchema,
                  }),
                ),
                annotations: {
                  destructiveHint: false,
                  idempotentHint: false,
                  openWorldHint: false,
                },
              },
              safeTool(async (args) => {
                if (!args.boardId) {
                  const intent = createIntent("create_from_mermaid", args);
                  const replay = creationReplay(args.idempotencyKey, intent);
                  if (replay) return replayReceipt(replay);
                }
                const { elements, convertedAsImage, fileCount } =
                  await measureMcpPhase("transformMs", () =>
                    buildMermaidScene(args.mermaid, uploadInternalFile),
                  );
                return await persistTextDiagram({
                  args,
                  generatedElements: elements,
                  defaultBgColor: "#ffffff",
                  toolName: "create_from_mermaid",
                  extraResult: { convertedAsImage, fileCount },
                });
              }, "create_from_mermaid"),
            );

            server.registerTool(
              "create_from_markdown",
              {
                title: "通过 Markdown 大纲创建或追加思维导图",
                description:
                  "将 Markdown 层级大纲（# 标题与 - 无序列表）转换为手绘风格思维导图。传 boardId 可直接追加到已有画板的 (x, y) 位置；不传 boardId 时新建画板（需传 name）。适合知识结构、脑暴大纲、目录树等树形层级图，无需提供任何坐标或样式。",
                inputSchema: compactMcpSchema(
                  z.object({
                    name: z
                      .string()
                      .trim()
                      .min(1)
                      .max(120)
                      .optional()
                      .describe("新建画板名称（不传 boardId 时必填）"),
                    boardId: z
                      .string()
                      .min(1)
                      .max(128)
                      .optional()
                      .describe("可选目标画板 ID；传入时追加到该画板而非新建"),
                    expectedRevision: expectedRevisionSchema,
                    x: z
                      .number()
                      .finite()
                      .optional()
                      .describe("导图左上角目标 X 坐标（默认 0）"),
                    y: z
                      .number()
                      .finite()
                      .optional()
                      .describe("导图左上角目标 Y 坐标（默认 0）"),
                    markdown: z
                      .string()
                      .min(1)
                      .max(50_000)
                      .describe(
                        "Markdown 层级大纲文本，使用 # 标题与 - 缩进列表表达父子层级",
                      ),
                    theme: z
                      .enum(["light", "dark"])
                      .optional()
                      .describe("导图配色主题，默认 light"),
                    ...boardMetadataSchema,
                    responseMode: responseModeSchema,
                    idempotencyKey: idempotencyKeySchema,
                  }),
                ),
                annotations: {
                  destructiveHint: false,
                  idempotentHint: false,
                  openWorldHint: false,
                },
              },
              safeTool(async (args) => {
                if (!args.boardId) {
                  const intent = createIntent("create_from_markdown", args);
                  const replay = creationReplay(args.idempotencyKey, intent);
                  if (replay) return replayReceipt(replay);
                }
                const { elements, nodeCount } = measureMcpPhase(
                  "transformMs",
                  () =>
                    buildMarkdownMindmapScene(
                      args.markdown,
                      args.theme ?? "light",
                    ),
                );
                return await persistTextDiagram({
                  args,
                  generatedElements: elements,
                  defaultBgColor: args.theme === "dark" ? "#121212" : "#ffffff",
                  toolName: "create_from_markdown",
                  extraResult: { nodeCount },
                });
              }, "create_from_markdown"),
            );

            registerElementTools(server, {
              runtime,
              api,
              result,
              safeTool,
            });

            server.registerTool(
              "get_boards_batch",
              {
                title: "批量读取画板",
                description:
                  "一次读取最多20块画板，默认compact语义阅读；支持input可写视图，共享字符预算。partial仅表示成功失败混合，truncated仅表示内容或预算截断；不存在的ID只报错，无需续读。不构成跨画板一致快照。",
                inputSchema: compactMcpSchema(
                  z.strictObject({
                    boardIds: z
                      .array(z.string().min(1).max(128))
                      .min(1)
                      .max(20),
                    view: z
                      .enum(["summary", "compact", "elements", "full", "input"])
                      .optional(),
                    maxChars: z
                      .number()
                      .int()
                      .min(1_000)
                      .max(2_000_000)
                      .optional()
                      .describe(
                        "含所有画板与逐项错误的总预算，最少1000；连结果元数据也放不下时报 READ_BUDGET_TOO_SMALL",
                      ),
                  }),
                ),
                annotations: {
                  readOnlyHint: true,
                  idempotentHint: true,
                  openWorldHint: false,
                },
              },
              safeTool(
                async ({
                  boardIds,
                  view = "compact",
                  maxChars = 1_000_000,
                }) => {
                  const boards = boardIds.map((boardId) =>
                    projectMcpRecord({
                      ok: false,
                      boardId,
                      truncated: true,
                      error: {
                        code: "READ_BUDGET_EXHAUSTED",
                        message: "预算不足，请单独读取该画板。",
                      },
                    }),
                  );
                  const boardLengths = boards.map(
                    (board) => JSON.stringify(board).length,
                  );
                  const emptyEnvelopeChars = JSON.stringify({
                    ok: false,
                    boards: [],
                    maxChars,
                    partial: false,
                    truncated: false,
                  }).length;
                  let usedChars =
                    emptyEnvelopeChars +
                    boardLengths.reduce((total, length) => total + length, 0) +
                    Math.max(0, boards.length - 1);
                  if (usedChars > maxChars) {
                    throw new HttpError(
                      400,
                      "READ_BUDGET_TOO_SMALL",
                      "批量结果的必要元数据超过预算，请增加 maxChars 或减少 boardIds。",
                    );
                  }
                  for (const [index, boardId] of boardIds.entries()) {
                    // Charge the complete envelope while reserving a bounded outcome for every remaining board.
                    const available =
                      maxChars - usedChars + boardLengths[index] - 16;
                    if (available < 128) continue;
                    try {
                      const nextBoard = {
                        ok: true,
                        ...(await readBoard({
                          boardId,
                          view,
                          maxChars: available,
                        })),
                      };
                      const nextLength = JSON.stringify(nextBoard).length;
                      boards[index] = nextBoard;
                      usedChars += nextLength - boardLengths[index];
                      boardLengths[index] = nextLength;
                    } catch (error) {
                      if (!(error instanceof HttpError)) throw error;
                      const outcome = projectMcpRecord({
                        ok: false,
                        boardId,
                        ...(error.code === "READ_BUDGET_TOO_SMALL"
                          ? { truncated: true }
                          : {}),
                        error: mcpError(error),
                      });
                      const outcomeLength = JSON.stringify(outcome).length;
                      if (outcomeLength <= available) {
                        boards[index] = outcome;
                        usedChars += outcomeLength - boardLengths[index];
                        boardLengths[index] = outcomeLength;
                      }
                    }
                  }
                  const failed = boards.filter((board) => board.error).length;
                  return result({
                    boards,
                    maxChars,
                    partial: failed > 0 && failed < boards.length,
                    truncated: boards.some((board) => board.truncated === true),
                  });
                },
                "get_boards_batch",
              ),
            );

            registerManagementTools(server, {
              runtime,
              api,
              result,
              safeTool,
            });

            return server;
          },
          {
            maxRequestBodySize: runtime.config.maxSceneBodyBytes,
            onerror(error) {
              console.info("[MCP] 请求处理失败", error);
            },
          },
        )
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

      const rateKey = `mcp:${getClientKey(runtime, req, requestAddressResolver)}`;
      const attempt = consumeRateLimit(
        runtime.authAttempts,
        rateKey,
        runtime.config.authAttemptsPerWindow,
        AUTH_RATE_WINDOW_MS,
      );
      if (!attempt.allowed) {
        return jsonResponse(
          runtime,
          req,
          { error: "MCP 授权尝试过多，请稍后重试", code: "MCP_RATE_LIMITED" },
          429,
          { "Retry-After": String(attempt.retryAfter) },
        );
      }

      const providedToken = getPathToken(req);
      const providedHash = new Uint8Array(
        new Bun.CryptoHasher("sha256").update(providedToken).digest(),
      );
      const expectedHash = new Uint8Array(
        new Bun.CryptoHasher("sha256").update(expectedToken).digest(),
      );
      if (!timingSafeEqual(providedHash, expectedHash)) {
        return jsonResponse(
          runtime,
          req,
          { error: "MCP 授权令牌无效或缺失", code: "MCP_UNAUTHORIZED" },
          401,
        );
      }
      runtime.authAttempts.delete(rateKey);

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
        unregisterInternalSession(runtime, internalSessionToken);
      }
      await mcp?.close();
    },
  };
};
