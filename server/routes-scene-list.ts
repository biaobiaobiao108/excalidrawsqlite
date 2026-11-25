import { HttpError } from "./errors";
import { jsonResponse, readJson } from "./http";
import { getSceneSummary, storedSceneRevision } from "./scenes";
import { requireJsonObject, requireRevision, validateId } from "./validation";
import { getWorkspaceStats } from "./workspace";
import {
  publishSceneChanged,
  publishWorkspaceChanged,
  type RouteContext,
} from "./routes-shared";
import type { ServerRuntime } from "./types";

const DEFAULT_SCENE_PAGE_SIZE = 50;
const MAX_SCENE_PAGE_SIZE = 100;
const MAX_SCENE_BATCH_SIZE = 500;
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

const parseSceneBatchEntries = (body: Record<string, unknown>) => {
  if (
    !Array.isArray(body.scenes) ||
    body.scenes.length < 1 ||
    body.scenes.length > MAX_SCENE_BATCH_SIZE
  ) {
    throw new HttpError(
      400,
      "INVALID_SCENE_BATCH",
      `批量操作必须包含 1-${MAX_SCENE_BATCH_SIZE} 个画板`,
    );
  }
  const entries = body.scenes.map((value) => {
    const entry = requireJsonObject(value);
    const revision = requireRevision(entry.revision);
    if (revision === undefined) {
      throw new HttpError(400, "INVALID_REVISION", "revision 必须是正整数");
    }
    return {
      id: validateId(entry.id, "scene"),
      revision,
    };
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new HttpError(400, "INVALID_SCENE_BATCH", "批量操作不能包含重复画板");
  }
  return entries;
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

const listScenePage = (runtime: ServerRuntime, url: URL, trashed: boolean) => {
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

export const handleSceneListRoute = async ({
  runtime,
  req,
  url,
  pathname,
  stmts,
}: RouteContext): Promise<Response | null> => {
  if (pathname === "/api/workspace/stats" && req.method === "GET") {
    return jsonResponse(runtime, req, getWorkspaceStats(runtime));
  }

  if (pathname === "/api/scenes" && req.method === "GET") {
    return jsonResponse(runtime, req, listScenePage(runtime, url, false));
  }

  if (pathname === "/api/scenes/trash" && req.method === "GET") {
    return jsonResponse(runtime, req, listScenePage(runtime, url, true));
  }

  if (
    pathname === "/api/scenes/batch" &&
    (req.method === "PATCH" || req.method === "DELETE")
  ) {
    const body = requireJsonObject(
      await readJson(
        req,
        runtime.config.maxSceneBodyBytes,
        runtime.bodyMemoryBudget,
      ),
    );
    if (
      req.method === "PATCH" &&
      body.deleted !== undefined &&
      typeof body.deleted !== "boolean"
    ) {
      throw new HttpError(400, "INVALID_DELETED", "deleted 必须是布尔值");
    }
    const entries = parseSceneBatchEntries(body);
    const isPermanent = req.method === "DELETE";
    const isRestore = !isPermanent && body.deleted === false;
    const now = Date.now();
    const changedEntries: typeof entries = [];
    const transaction = runtime.db.transaction(() => {
      for (const entry of entries) {
        const existing = stmts.getSceneStateById.get(entry.id) as {
          id: string;
          deleted_at: number | null;
          revision: number;
        } | null;
        if (
          !existing ||
          storedSceneRevision(existing.revision) !== entry.revision ||
          (isPermanent && existing.deleted_at === null)
        ) {
          throw new HttpError(
            409,
            "SCENE_SELECTION_STALE",
            "选中的画板已发生变化，请刷新列表后重新选择",
          );
        }
        if (
          isPermanent ||
          (isRestore
            ? existing.deleted_at !== null
            : existing.deleted_at === null)
        ) {
          changedEntries.push(entry);
        }
      }

      for (const entry of changedEntries) {
        if (isPermanent) {
          stmts.deleteSceneFileReferences.run(entry.id);
          const result = stmts.deleteTrashedScene.run(entry.id, entry.revision);
          if (result.changes !== 1) {
            throw new HttpError(
              409,
              "SCENE_SELECTION_STALE",
              "选中的画板已发生变化，请刷新列表后重新选择",
            );
          }
        } else if (isRestore) {
          const result = stmts.restoreScene.run(now, entry.id, entry.revision);
          if (result.changes !== 1) {
            throw new HttpError(
              409,
              "SCENE_SELECTION_STALE",
              "选中的画板已发生变化，请刷新列表后重新选择",
            );
          }
        } else {
          const result = stmts.softDeleteScene.run(
            now,
            now,
            entry.id,
            entry.revision,
          );
          if (result.changes !== 1) {
            throw new HttpError(
              409,
              "SCENE_SELECTION_STALE",
              "选中的画板已发生变化，请刷新列表后重新选择",
            );
          }
        }
      }
    });
    transaction.immediate();
    for (const entry of changedEntries) {
      publishSceneChanged(runtime, {
        type: "scene_changed",
        sceneId: entry.id,
        revision: entry.revision + (isPermanent ? 0 : 1),
        updatedAt: now,
        changeKind: isRestore ? "restored" : "deleted",
      });
    }
    if (changedEntries.length) {
      publishWorkspaceChanged(runtime, now);
    }
    return jsonResponse(runtime, req, {
      success: true,
      ids: entries.map((entry) => entry.id),
      deleted: !isRestore,
      permanent: isPermanent,
      deleted_at: isPermanent || isRestore ? null : now,
      noop: changedEntries.length === 0,
    });
  }

  if (pathname === "/api/scenes/trash" && req.method === "DELETE") {
    const result = runtime.db.run(
      "DELETE FROM scenes WHERE deleted_at IS NOT NULL",
    );
    if (result.changes > 0) {
      publishWorkspaceChanged(runtime, Date.now());
    }
    return jsonResponse(runtime, req, {
      success: true,
      deletedCount: result.changes,
    });
  }

  return null;
};
