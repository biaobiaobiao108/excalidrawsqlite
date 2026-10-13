import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { HttpError } from "./errors";
import { getSceneSummary } from "./scenes";
import { validateTags } from "./validation";
import type { ServerRuntime } from "./types";
import { colorSchema } from "./color";
import { compactMcpSchema } from "./mcp-schema";

export type ManagementApi = <T>(path: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown) => Promise<T>;
type ToolResult = { structuredContent: Record<string, unknown> & { ok: boolean }; content: Array<{ type: "text"; text: string }> };
type Context = {
  runtime: ServerRuntime;
  api: ManagementApi;
  result: (value: Record<string, unknown>) => ToolResult;
  safeTool: <T>(handler: (args: T) => Promise<ToolResult>) => (args: T) => Promise<ToolResult>;
  boardUrl: (id: string) => string;
};
type Folder = { id: string; name: string; icon: string; color: string; scene_count: number; [key: string]: unknown };
const folderFields = {
  folderId: z.string().min(1).max(128).optional(),
  folderName: z.string().trim().min(1).max(80).optional(),
};
const iconSchema = z.enum(["folder", "book", "palette", "lightbulb", "layers", "star", "image", "code", "bookmark", "file", "tag", "heart", "compass", "briefcase"]);
const tagsSchema = z.array(z.string().trim().min(1).max(32)).max(12);
const expectedRevisionSchema = z.number().int().positive().optional().describe("读取时修订号；省略则基于最新版本管理，冲突需重新读取判断");

async function findFolder(input: { folderId?: string | null; folderName?: string }, api: ManagementApi) {
  if (input.folderId === undefined && input.folderName === undefined) throw new HttpError(400, "INVALID_FOLDER_SELECTOR", "请提供 folderId 或 folderName");
  if (input.folderId !== undefined && input.folderName !== undefined) throw new HttpError(400, "INVALID_FOLDER", "folderId 与 folderName 不能同时传入");
  const folders = await api<Folder[]>("/api/folders", "GET");
  const matches = folders.filter((folder) => input.folderId !== undefined ? folder.id === input.folderId : folder.name.trim() === input.folderName?.trim());
  if (matches.length > 1) throw new HttpError(409, "AMBIGUOUS_FOLDER", "存在多个同名文件夹，请使用 folderId");
  return matches[0];
}

async function ensureNamedFolder(args: { name: string; icon?: string; color?: string }, api: ManagementApi) {
  const existing = await findFolder({ folderName: args.name }, api);
  if (existing) return { folder: existing, created: false };
  try {
    return { folder: await api<Folder>("/api/folders", "POST", args), created: true };
  } catch (error) {
    // The route checks names synchronously inside the write transaction. If another
    // request won after our lookup, resolve that folder instead of creating a duplicate.
    if (!(error instanceof HttpError) || error.code !== "FOLDER_NAME_EXISTS") throw error;
    const folder = await findFolder({ folderName: args.name }, api);
    if (!folder) throw error;
    return { folder, created: false };
  }
}

/** Creating or moving a board can ensure its named folder in the same tool call. */
export async function resolveFolder(input: { folderId?: string | null; folderName?: string }, api: ManagementApi): Promise<string | null | undefined> {
  if (input.folderId === undefined && input.folderName === undefined) return undefined;
  if (input.folderId === null && input.folderName === undefined) return null;
  const folder = await findFolder(input, api);
  if (folder) return folder.id;
  if (input.folderName !== undefined) return (await ensureNamedFolder({ name: input.folderName }, api)).folder.id;
  throw new HttpError(404, "FOLDER_NOT_FOUND", "文件夹不存在");
}

const metadataSchema = z.strictObject({
  boardId: z.string().min(1).max(128), expectedRevision: expectedRevisionSchema,
  name: z.string().trim().min(1).max(120).optional(),
  favorite: z.boolean().optional(),
  folderId: z.string().min(1).max(128).nullable().optional().describe("移入文件夹；null 移到根目录，与 folderName 二选一"),
  folderName: folderFields.folderName.describe("精确文件夹名，不存在则自动创建"),
  tags: tagsSchema.optional(),
  tagMode: z.enum(["replace", "add", "remove"]).optional().describe("传 tags 时必须显式指定；replace+空数组清空标签"),
});
type ManageInput = z.infer<typeof metadataSchema>;
const queryCache = new WeakMap<ServerRuntime, ReturnType<ServerRuntime["db"]["query"]>>();
async function readSummary(runtime: ServerRuntime, id: string) {
  let statement = queryCache.get(runtime);
  if (!statement) {
    statement = runtime.db.query("SELECT scenes.id, scenes.name, scenes.created_at, scenes.updated_at, scenes.revision, scenes.content_bytes AS size, scenes.element_count, scenes.tags_json, scenes.is_favorite, scenes.folder_id, scenes.last_opened_at, scenes.thumbnail_file_id, scenes.deleted_at, folders.name AS folder_name FROM scenes LEFT JOIN folders ON folders.id = scenes.folder_id WHERE scenes.id = ?");
    queryCache.set(runtime, statement);
  }
  const row = await statement.get(id);
  if (!row) throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在");
  return getSceneSummary(row);
}
const folderCountCache = new WeakMap<ServerRuntime, ReturnType<ServerRuntime["db"]["query"]>>();
const tagQueryCache = new WeakMap<ServerRuntime, ReturnType<ServerRuntime["db"]["query"]>>();
async function folderBoardCount(runtime: ServerRuntime, id: string) {
  let statement = folderCountCache.get(runtime);
  if (!statement) {
    statement = runtime.db.query("SELECT COUNT(*) AS count FROM scenes WHERE folder_id = ?");
    folderCountCache.set(runtime, statement);
  }
  return (await statement.get<{ count: number }>(id))?.count ?? 0;
}
function assertRevision(revision: number, expected?: number) {
  if (expected !== undefined && revision !== expected) throw new HttpError(409, "REVISION_CONFLICT", `画板已更新，当前修订号为 ${revision}；请重新读取判断`);
}

export function registerManagementTools(server: McpServer, context: Context) {
  const { runtime, api, result, safeTool, boardUrl } = context;
  const manage = async (input: ManageInput) => {
    const current = await readSummary(runtime, input.boardId);
    assertRevision(current.revision, input.expectedRevision);
    if (current.deleted_at !== null) throw new HttpError(404, "SCENE_NOT_FOUND", "画板已删除，请先 restore_board");
    if ((input.tags === undefined) !== (input.tagMode === undefined)) throw new HttpError(400, "INVALID_TAGS", "tags 与 tagMode 必须一起提供");
    if (![input.name, input.favorite, input.folderId, input.folderName, input.tags].some((value) => value !== undefined)) throw new HttpError(400, "INVALID_METADATA", "至少提供一项改名、收藏、移动或标签操作");
    const folderId = await resolveFolder(input, api);
    const tags = input.tags === undefined ? current.tags : validateTags(input.tagMode === "replace" ? input.tags : input.tagMode === "add" ? [...new Set([...current.tags, ...input.tags])] : current.tags.filter((tag) => !input.tags!.includes(tag)));
    const metadata = { name: input.name ?? current.name, favorite: input.favorite ?? current.favorite, folder_id: folderId === undefined ? current.folder_id : folderId, tags };
    const noop = metadata.name === current.name && metadata.favorite === current.favorite && metadata.folder_id === current.folder_id && tags.length === current.tags.length && tags.every((tag) => current.tags.includes(tag));
    const board = noop ? current : await api<Record<string, unknown>>(`/api/scenes/${encodeURIComponent(input.boardId)}`, "PATCH", { ...metadata, baseRevision: current.revision });
    return { ...board, boardId: input.boardId, noop, url: boardUrl(input.boardId) };
  };
  const setDeleted = async (boardId: string, deleted: boolean, expectedRevision?: number) => {
    const current = await readSummary(runtime, boardId);
    assertRevision(current.revision, expectedRevision);
    const noop = (current.deleted_at !== null) === deleted;
    if (!noop) await api("/api/scenes/batch", "PATCH", { scenes: [{ id: boardId, revision: current.revision }], deleted });
    const board = await readSummary(runtime, boardId);
    return { ...board, boardId, noop, deleted, url: boardUrl(boardId) };
  };
  server.registerTool("list_folders", { description: "分页列出文件夹及画板数量，支持名称搜索；已有名称时可直接传给 create_board/manage_board 无需先查询。", inputSchema: compactMcpSchema(z.strictObject({ query: z.string().max(80).optional(), cursor: z.string().min(1).max(128).optional(), limit: z.number().int().min(1).max(100).default(50) })), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, safeTool(async ({ query, cursor, limit }) => {
    const folders = (await api<Folder[]>("/api/folders", "GET")).filter((folder) => !query || folder.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    const offset = cursor ? folders.findIndex((folder) => folder.id === cursor) + 1 : 0;
    if (cursor && offset === 0) throw new HttpError(400, "INVALID_CURSOR", "文件夹分页游标无效，请重新从第一页读取");
    const page = folders.slice(offset, offset + limit);
    return result({ folders: page, nextCursor: offset + limit < folders.length ? page.at(-1)!.id : null });
  }));
  let tagQuery = tagQueryCache.get(runtime);
  if (!tagQuery) {
    tagQuery = runtime.db.query("SELECT tag.value AS name, COUNT(DISTINCT scenes.id) AS boardCount FROM scenes, json_each(scenes.tags_json) AS tag WHERE scenes.deleted_at IS NULL AND tag.type = 'text' AND tag.value > ? GROUP BY tag.value ORDER BY tag.value LIMIT ?");
    tagQueryCache.set(runtime, tagQuery);
  }
  const tagsStatement = tagQuery;
  server.registerTool("list_tags", { description: "列出在用标签及画板数量，按名称排序；cursor 是上一页最后名称的排序边界，即使该标签删除或改名仍可继续，非快照分页不保证包含分页期间移到边界前的新名称。标签直接在 create_board/manage_board 使用，无需单独创建。", inputSchema: compactMcpSchema(z.strictObject({ cursor: z.string().max(32).optional(), limit: z.number().int().min(1).max(100).default(50) })), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } }, safeTool(async ({ cursor, limit }) => {
    const rows = await tagsStatement.all<{ name: string; boardCount: number }>(cursor ?? "", limit + 1);
    const tags = rows.slice(0, limit);
    return result({ tags, nextCursor: rows.length > limit ? tags.at(-1)!.name : null });
  }));
  const folderCreateSchema = z.strictObject({ name: z.string().trim().min(1).max(80), icon: iconSchema.optional(), color: colorSchema.optional() });
  server.registerTool("create_folder", { description: "创建文件夹并返回 ID；名称去除首尾空白、区分大小写，已存在时报 FOLDER_NAME_EXISTS。需要复用时使用 ensure_folder。", inputSchema: compactMcpSchema(folderCreateSchema), annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false } }, safeTool(async (args) => result(await api<Folder>("/api/folders", "POST", args))));
  server.registerTool("ensure_folder", { description: "按去除首尾空白后的精确名称查找或创建文件夹（区分大小写），返回 created；已有文件夹保持颜色和图标，历史同名歧义时报错并要求使用 folderId。", inputSchema: compactMcpSchema(folderCreateSchema), annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false } }, safeTool(async (args) => {
    const { folder, created } = await ensureNamedFolder(args, api);
    return result({ ...folder, created });
  }));
  server.registerTool("update_folder", { description: "改名、颜色和图标可在一次调用中合并；folderId/folderName 二选一用于精确定位。", inputSchema: compactMcpSchema(z.strictObject({ ...folderFields, name: z.string().trim().min(1).max(80).optional(), icon: iconSchema.optional(), color: colorSchema.optional() })), annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false } }, safeTool(async (args) => {
    const existing = await findFolder(args, api);
    if (!existing) throw new HttpError(404, "FOLDER_NOT_FOUND", "文件夹不存在");
    const metadata = { name: args.name ?? existing.name, icon: args.icon ?? existing.icon, color: args.color?.toLowerCase() ?? existing.color };
    const noop = metadata.name === existing.name && metadata.icon === existing.icon && metadata.color === existing.color;
    return result({ ...(noop ? existing : await api<Folder>(`/api/folders/${encodeURIComponent(existing.id)}`, "PATCH", metadata)), noop });
  }));
  server.registerTool("delete_folder", { description: "删除文件夹并将其中画板移到根目录，保留全部画板；dryRun=true 预览，执行必须 confirm=true，可传 expectedBoardCount 防止数量变化误操作。", inputSchema: compactMcpSchema(z.strictObject({ ...folderFields, dryRun: z.boolean().default(false), confirm: z.boolean().optional(), expectedBoardCount: z.number().int().nonnegative().optional() })), annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false } }, safeTool(async (args) => {
    const folder = await findFolder(args, api);
    if (!folder) throw new HttpError(404, "FOLDER_NOT_FOUND", "文件夹不存在");
    const boardCount = await folderBoardCount(runtime, folder.id);
    if (args.dryRun) return result({ folder, wouldMoveBoards: boardCount, dryRun: true });
    if (args.confirm !== true) throw new HttpError(400, "CONFIRM_REQUIRED", "删除文件夹需要 confirm=true；可先 dryRun=true 预览");
    if (args.expectedBoardCount !== undefined && boardCount !== args.expectedBoardCount) throw new HttpError(409, "FOLDER_CHANGED", "文件夹画板数量发生变化，请重新预览");
    return result({ ...await api<Record<string, unknown>>(`/api/folders/${encodeURIComponent(folder.id)}`, "DELETE"), movedBoards: boardCount });
  }));
  server.registerTool("manage_board", { description: "一次合并画板改名、收藏、移入文件夹和标签增删替换，不读取或回传完整图元；相同内容返回 noop 且不递增 revision。", inputSchema: compactMcpSchema(metadataSchema), annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false } }, safeTool(async (args) => result(await manage(args))));
  const stateSchema = z.strictObject({ boardId: z.string().min(1).max(128), expectedRevision: expectedRevisionSchema });
  server.registerTool("delete_board", { description: "将画板软删除到回收站，保留内容和附件，可用 restore_board 还原；实际状态变化 revision+1，已删除时 noop。可传 expectedRevision 防止旧版本操作；没有永久删除选项。", inputSchema: compactMcpSchema(stateSchema), annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false } }, safeTool(async ({ boardId, expectedRevision }) => result(await setDeleted(boardId, true, expectedRevision))));
  server.registerTool("restore_board", { description: "从回收站恢复画板；实际还原 revision+1，已恢复时 noop。使用最新回执的 expectedRevision，删除再还原也会使旧版本失效。", inputSchema: compactMcpSchema(stateSchema), annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false } }, safeTool(async ({ boardId, expectedRevision }) => result(await setDeleted(boardId, false, expectedRevision))));
  const batchRevision = z.number().int().positive().describe("每项必须提供当前修订号，可来自 list_boards 或上次写入返回");
  const batchItemSchema = metadataSchema.extend({ action: z.enum(["manage", "delete", "restore"]), expectedRevision: batchRevision }).superRefine((item, ctx) => {
    if (item.action === "manage") return;
    for (const field of ["name", "favorite", "folderId", "folderName", "tags", "tagMode"] as const) {
      if (item[field] !== undefined) ctx.addIssue({ code: "custom", path: [field], message: `${field} 仅允许 action=manage；${item.action} 只接受 boardId 和 expectedRevision` });
    }
  });
  server.registerTool("batch_manage_boards", { description: "一次管理最多 100 个画板，每项必须传 expectedRevision，独立执行并返回成功/错误、revision 和 noop；支持 manage、delete(软删除)、restore。部分失败不回滚其他项，partial=true 表示部分成功，冲突项重新读取后判断。", inputSchema: compactMcpSchema(z.strictObject({ items: z.array(batchItemSchema).min(1).max(100) })), annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false } }, safeTool(async ({ items }) => {
    const outcomes: Record<string, unknown>[] = [];
    for (const item of items) {
      try {
        outcomes.push({ ok: true, action: item.action, ...(item.action === "manage" ? await manage(item) : await setDeleted(item.boardId, item.action === "delete", item.expectedRevision)) });
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        let revision: number | undefined;
        try { revision = (await readSummary(runtime, item.boardId)).revision; } catch { /* Missing boards have no revision. */ }
        outcomes.push({ ok: false, boardId: item.boardId, action: item.action, ...(revision === undefined ? {} : { revision }), error: { code: error.code, message: error.message } });
      }
    }
    const succeeded = outcomes.filter((item) => item.ok).length;
    return result({ results: outcomes, succeeded, failed: outcomes.length - succeeded, partial: succeeded > 0 && succeeded < outcomes.length });
  }));
}

