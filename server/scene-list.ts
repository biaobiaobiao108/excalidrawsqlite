import { HttpError } from "./errors";
import { getSceneSummary } from "./scenes";

import type { ServerRuntime } from "./types";

const DEFAULT_SCENE_PAGE_SIZE = 50;
const MAX_SCENE_PAGE_SIZE = 100;
const MAX_SCENE_BATCH_SIZE = 500;
const MAX_THUMBNAIL_VERSION_FUTURE_SKEW_MS = 5 * 60 * 1000;
const sceneCursorEncoder = new TextEncoder();
const sceneCursorDecoder = new TextDecoder();

// Filter combinations have a finite set of SQL shapes; values stay bound parameters.
const sceneCountQueries = new WeakMap<
  ServerRuntime,
  Map<string, ReturnType<ServerRuntime["db"]["query"]>>
>();

const getScenePageCount = (
  runtime: ServerRuntime,
  conditions: string[],
  params: Array<string | number>,
) => {
  let queries = sceneCountQueries.get(runtime);
  if (!queries) {
    queries = new Map();
    sceneCountQueries.set(runtime, queries);
  }
  const where = conditions.join(" AND ");
  let query = queries.get(where);
  if (!query) {
    query = runtime.db.query(`
      SELECT COUNT(*) AS count FROM scenes
      LEFT JOIN folders ON folders.id = scenes.folder_id
      WHERE ${where}
    `);
    queries.set(where, query);
  }
  return (query.get(...params) as { count: number }).count;
};

const encodeSceneCursor = (row: {
  cursor_value?: number;
  updated_at?: number;
  deleted_at?: number | null;
  id: string;
}) => {
  const timestamp = row.cursor_value ?? row.deleted_at ?? row.updated_at;
  return sceneCursorEncoder
    .encode(`${timestamp}:${row.id}`)
    .toBase64({ alphabet: "base64url", omitPadding: true });
};

const decodeSceneCursor = (value: string | null) => {
  if (!value) {
    return null;
  }
  try {
    const decoded = sceneCursorDecoder.decode(
      Uint8Array.fromBase64(value, { alphabet: "base64url" }),
    );
    const separator = decoded.indexOf(":");
    const timestamp = Number(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (
      separator <= 0 ||
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0 ||
      !id
    ) {
      throw new Error("invalid cursor");
    }
    return { timestamp, id };
  } catch {
    throw new HttpError(400, "INVALID_CURSOR", "分页游标无效");
  }
};

const parseScenePageSize = (value: string | null) => {
  if (!value) {
    return DEFAULT_SCENE_PAGE_SIZE;
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_SCENE_PAGE_SIZE
  ) {
    throw new HttpError(
      400,
      "INVALID_LIMIT",
      `分页大小必须是 1-${MAX_SCENE_PAGE_SIZE} 之间的整数`,
    );
  }
  return parsed;
};

export const listScenePage = (
  runtime: ServerRuntime,
  url: URL,
  trashed: boolean,
) => {
  const limit = parseScenePageSize(url.searchParams.get("limit"));
  const cursor = decodeSceneCursor(url.searchParams.get("cursor"));
  const query = url.searchParams.get("q")?.trim() || "";
  const tag = url.searchParams.get("tag")?.trim() || "";
  if (query.length > 120) {
    throw new HttpError(400, "INVALID_QUERY", "搜索关键词过长");
  }
  if (tag.length > 120) {
    throw new HttpError(400, "INVALID_TAG", "标签关键词过长");
  }
  const opened = url.searchParams.has("opened")
    ? url.searchParams.get("opened")
    : undefined;
  if (opened !== undefined && opened !== "true" && opened !== "false") {
    throw new HttpError(400, "INVALID_OPENED", "opened 参数无效");
  }
  const hasFolderFilter = url.searchParams.has("folder_id");
  const folderId = hasFolderFilter
    ? url.searchParams.get("folder_id")
    : undefined;
  const favorite = url.searchParams.has("favorite")
    ? url.searchParams.get("favorite")
    : undefined;
  if (favorite !== undefined && favorite !== "true" && favorite !== "false") {
    throw new HttpError(400, "INVALID_FAVORITE", "favorite 参数无效");
  }
  const requestedSort = url.searchParams.get("sort") || "updated";
  if (!trashed && !["updated", "opened", "created"].includes(requestedSort)) {
    throw new HttpError(400, "INVALID_SORT", "sort 参数无效");
  }

  const conditions = [
    trashed ? "scenes.deleted_at IS NOT NULL" : "scenes.deleted_at IS NULL",
  ];
  const params: Array<string | number> = [];
  if (query) {
    conditions.push(
      "(unicode_contains(scenes.name, ?) OR EXISTS (SELECT 1 FROM json_each(scenes.tags_json) AS search_tag WHERE search_tag.type = 'text' AND unicode_contains(search_tag.value, ?)) OR unicode_contains(folders.name, ?))",
    );
    params.push(query, query, query);
  }
  if (folderId) {
    conditions.push("scenes.folder_id = ?");
    params.push(folderId);
  } else if (hasFolderFilter) {
    conditions.push("scenes.folder_id IS NULL");
  }
  if (favorite !== undefined) {
    conditions.push("scenes.is_favorite = ?");
    params.push(favorite === "true" ? 1 : 0);
  }
  if (opened !== undefined) {
    conditions.push(
      opened === "true"
        ? "scenes.last_opened_at IS NOT NULL"
        : "scenes.last_opened_at IS NULL",
    );
  }
  if (tag) {
    conditions.push(
      "EXISTS (SELECT 1 FROM json_each(scenes.tags_json) AS tag WHERE tag.type = 'text' AND tag.value = ?)",
    );
    params.push(tag);
  }
  const includeTotal = url.searchParams.get("include_total");
  if (
    includeTotal !== null &&
    includeTotal !== "true" &&
    includeTotal !== "false"
  ) {
    throw new HttpError(400, "INVALID_INCLUDE_TOTAL", "include_total 参数无效");
  }
  const totalCount =
    includeTotal === "false"
      ? null
      : getScenePageCount(runtime, conditions, params);
  if (cursor) {
    const column = trashed
      ? "scenes.deleted_at"
      : requestedSort === "opened"
        ? opened === "true"
          ? "scenes.last_opened_at"
          : "COALESCE(scenes.last_opened_at, 0)"
        : requestedSort === "created"
          ? "scenes.created_at"
          : "scenes.updated_at";
    conditions.push(`(${column} < ? OR (${column} = ? AND scenes.id < ?))`);
    params.push(cursor.timestamp, cursor.timestamp, cursor.id);
  }

  const orderColumn = trashed
    ? "scenes.deleted_at"
    : requestedSort === "opened"
      ? opened === "true"
        ? "scenes.last_opened_at"
        : "COALESCE(scenes.last_opened_at, 0)"
      : requestedSort === "created"
        ? "scenes.created_at"
        : "scenes.updated_at";
  const rows = runtime.db
    .query(
      `SELECT scenes.id, scenes.name, scenes.created_at, scenes.updated_at,
              scenes.revision, scenes.content_bytes AS size,
              scenes.element_count,
              scenes.tags_json, scenes.is_favorite, scenes.folder_id,
              scenes.last_opened_at, scenes.thumbnail_file_id, scenes.deleted_at,
              ${orderColumn} AS cursor_value,
              folders.name AS folder_name
       FROM scenes
       LEFT JOIN folders ON folders.id = scenes.folder_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY ${orderColumn} DESC, scenes.id DESC
       LIMIT ?`,
    )
    .all(...params, limit + 1) as Array<{
    id: string;
    updated_at: number;
    deleted_at: number | null;
    cursor_value: number;
  }>;
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(getSceneSummary);
  return {
    items,
    totalCount,
    nextCursor: hasMore ? encodeSceneCursor(rows[limit - 1]) : null,
  };
};
