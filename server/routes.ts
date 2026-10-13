import {
  AUTH_RATE_WINDOW_MS,
  WRITE_RATE_WINDOW_MS,
  WRITE_REQUESTS_PER_WINDOW,
} from "./config";
import { randomHex, sha256Hex } from "./crypto";
import { HttpError } from "./errors";
import {
  clearSessionCookies,
  cleanupExpiredSessions,
  consumeRateLimit,
  getClientKey,
  getSessionToken,
  hashSessionToken,
  isAuthorized,
  issueSessionCookie,
  verifyPassword,
} from "./auth";
import {
  assertReferencedFilesExist,
  extractFileIds,
  getFileObject,
  getStoredFileMetadata,
  getSceneFileReferenceMutationStatements,
  stageRequestBodyToFile,
  withStorageMutationLock,
  upsertStagedFile,
  withThumbnailWriteLock,
} from "./files";
import {
  errorResponse,
  isAllowedOrigin,
  jsonResponse,
  readJson,
  releaseJsonBodyMemoryBudget,
  response,
} from "./http";
import {
  getSceneSummary,
  parseSceneMetadata,
  parseStoredScene,
  parseStoredElements,
  parseStoredAppState,
  storedSceneRevision,
  sanitizeSceneElements,
} from "./scenes";
import {
  hasOwn,
  requireJsonObject,
  requireRevision,
  validateAppState,
  validateElements,
  validateFolderColor,
  validateFolderIcon,
  validateFolderName,
  getPathId,
  validateId,
  validateMimeType,
  validateName,
} from "./validation";

import type { RequestAddressResolver, ServerRuntime } from "./types";
import { getWorkspaceStats } from "./workspace";
import path from "node:path";

const DEFAULT_SCENE_PAGE_SIZE = 50;
const MAX_SCENE_PAGE_SIZE = 100;
const MAX_SCENE_BATCH_SIZE = 500;
const MAX_THUMBNAIL_VERSION_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_D1_SCENE_ROW_BYTES = 1_950_000;
const D1_SCENE_METADATA_RESERVE_BYTES = 128;
const sceneCursorEncoder = new TextEncoder();
const sceneCursorDecoder = new TextDecoder();

// Filter combinations have a finite set of SQL shapes; values stay bound parameters.
const sceneCountQueries = new WeakMap<
  ServerRuntime,
  Map<string, ReturnType<ServerRuntime["db"]["query"]>>
>();

const getScenePageCount = async (
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
  const row = await query.get<{ count: number }>(...params);
  return Number(row?.count || 0);
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

const parseThumbnailVersion = (req: Request) => {
  const header = req.headers.get("x-thumbnail-version");
  if (!header) {
    return undefined;
  }
  const version = Number(header);
  if (
    !Number.isSafeInteger(version) ||
    version <= 0 ||
    version > Date.now() + MAX_THUMBNAIL_VERSION_FUTURE_SKEW_MS
  ) {
    throw new HttpError(
      400,
      "INVALID_THUMBNAIL_VERSION",
      "画板缩略图版本无效",
    );
  }
  return version;
};

const writeRateLimitResponse = async (
  runtime: ServerRuntime,
  req: Request,
  requestAddressResolver?: RequestAddressResolver,
) => {
  const rate = await consumeRateLimit(
    runtime,
    "write",
    getClientKey(runtime, req, requestAddressResolver),
    WRITE_REQUESTS_PER_WINDOW,
    WRITE_RATE_WINDOW_MS,
  );
  if (rate.allowed) {
    return null;
  }
  return jsonResponse(
    runtime,
    req,
    { error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" },
    429,
    { "Retry-After": String(rate.retryAfter) },
  );
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
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_SCENE_PAGE_SIZE) {
    throw new HttpError(
      400,
      "INVALID_LIMIT",
      `分页大小必须是 1-${MAX_SCENE_PAGE_SIZE} 之间的整数`,
    );
  }
  return parsed;
};

const escapeLikePattern = (value: string) =>
  value.replace(/[\\%_]/g, (character) => `\\${character}`);

const listScenePage = async (
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
  const folderId = hasFolderFilter ? url.searchParams.get("folder_id") : undefined;
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
    const pattern = `%${escapeLikePattern(query)}%`;
    conditions.push(
      "(scenes.name LIKE ? ESCAPE '\\' OR scenes.tags_json LIKE ? ESCAPE '\\' OR folders.name LIKE ? ESCAPE '\\')",
    );
    params.push(pattern, pattern, pattern);
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
  const totalCount = await getScenePageCount(runtime, conditions, params);
  if (cursor) {
    const column = trashed
      ? "scenes.deleted_at"
      : requestedSort === "opened"
      ? "COALESCE(scenes.last_opened_at, 0)"
      : requestedSort === "created"
      ? "scenes.created_at"
      : "scenes.updated_at";
    conditions.push(
      `(${column} < ? OR (${column} = ? AND scenes.id < ?))`,
    );
    params.push(cursor.timestamp, cursor.timestamp, cursor.id);
  }

  const orderColumn = trashed
    ? "scenes.deleted_at"
    : requestedSort === "opened"
    ? "COALESCE(scenes.last_opened_at, 0)"
    : requestedSort === "created"
    ? "scenes.created_at"
    : "scenes.updated_at";
  const rows = await runtime.db
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
    .all<{ id: string; updated_at: number; deleted_at: number | null; cursor_value: number }>(...params, limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(getSceneSummary);
  return {
    items,
    totalCount,
    nextCursor: hasMore
      ? encodeSceneCursor(rows[limit - 1])
      : null,
  };
};

const publishSceneChanged = (
  runtime: ServerRuntime,
  event: Parameters<NonNullable<ServerRuntime["realtime"]>["publishSceneChanged"]>[0],
) => runtime.realtime?.publishSceneChanged(event);

const publishWorkspaceChanged = (runtime: ServerRuntime, updatedAt?: number) =>
  runtime.realtime?.publishWorkspaceChanged(updatedAt);

const getFolderSummary = async (runtime: ServerRuntime, id: string) =>
  runtime.db
    .query(
      `SELECT folders.id, folders.name, folders.icon, folders.color,
              folders.created_at, folders.updated_at,
              COUNT(scenes.id) AS scene_count
       FROM folders
       LEFT JOIN scenes
         ON scenes.folder_id = folders.id
        AND scenes.deleted_at IS NULL
       WHERE folders.id = ?
       GROUP BY folders.id`,
    )
    .get(id);

const preparedStatementsMap = new WeakMap<
  ServerRuntime,
  {
    healthCheck: ReturnType<ServerRuntime["db"]["query"]>;
    getFileById: ReturnType<ServerRuntime["db"]["query"]>;
    getSceneById: ReturnType<ServerRuntime["db"]["query"]>;
    getSceneRawById: ReturnType<ServerRuntime["db"]["query"]>;
    getSceneVersionById: ReturnType<ServerRuntime["db"]["query"]>;
    getSceneMetadataById: ReturnType<ServerRuntime["db"]["query"]>;
    getSceneStateById: ReturnType<ServerRuntime["db"]["query"]>;
    softDeleteScene: ReturnType<ServerRuntime["db"]["query"]>;
    restoreScene: ReturnType<ServerRuntime["db"]["query"]>;
    deleteSceneFileReferences: ReturnType<ServerRuntime["db"]["query"]>;
    deleteTrashedScene: ReturnType<ServerRuntime["db"]["query"]>;
    getSceneRevision: ReturnType<ServerRuntime["db"]["query"]>;
    getSceneThumbnailById: ReturnType<ServerRuntime["db"]["query"]>;
    getSceneSummaryById: ReturnType<ServerRuntime["db"]["query"]>;
    touchSceneLastOpened: ReturnType<ServerRuntime["db"]["query"]>;
    getFolderById: ReturnType<ServerRuntime["db"]["query"]>;
    getFolderNameConflict: ReturnType<ServerRuntime["db"]["query"]>;
    getFileUpdatedAt: ReturnType<ServerRuntime["db"]["query"]>;
    listFolders: ReturnType<ServerRuntime["db"]["query"]>;
  }
>();

const getPreparedStatements = (runtime: ServerRuntime) => {
  let stmts = preparedStatementsMap.get(runtime);
  if (!stmts) {
    stmts = {
      healthCheck: runtime.db.query("SELECT 1"),
      getFileById: runtime.db.query("SELECT * FROM files WHERE id = ?"),
      getSceneById: runtime.db.query(
        "SELECT id FROM scenes WHERE id = ? AND deleted_at IS NULL",
      ),
      getSceneRawById: runtime.db.query(
        "SELECT * FROM scenes WHERE id = ? AND deleted_at IS NULL",
      ),
      getSceneVersionById: runtime.db.query(
        `SELECT id, revision, updated_at, thumbnail_file_id, last_opened_at
         FROM scenes
         WHERE id = ? AND deleted_at IS NULL`,
      ),
      getSceneMetadataById: runtime.db.query(
        `SELECT id, name, tags_json, is_favorite, folder_id, revision
         FROM scenes
         WHERE id = ? AND deleted_at IS NULL`,
      ),
      getSceneStateById: runtime.db.query(
        "SELECT id, deleted_at, revision FROM scenes WHERE id = ?",
      ),
      softDeleteScene: runtime.db.query(
        `UPDATE scenes SET deleted_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
      ),
      restoreScene: runtime.db.query(
        `UPDATE scenes SET deleted_at = NULL, updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ? AND deleted_at IS NOT NULL`,
      ),
      deleteSceneFileReferences: runtime.db.query(
        "DELETE FROM scene_files WHERE scene_id = ?",
      ),
      deleteTrashedScene: runtime.db.query(
        "DELETE FROM scenes WHERE id = ? AND revision = ? AND deleted_at IS NOT NULL",
      ),
      getSceneRevision: runtime.db.query(
        "SELECT revision FROM scenes WHERE id = ?",
      ),
      getSceneThumbnailById: runtime.db.query(
        "SELECT id, thumbnail_file_id FROM scenes WHERE id = ? AND deleted_at IS NULL",
      ),
      getSceneSummaryById: runtime.db.query(
        `SELECT scenes.id, scenes.name, scenes.created_at, scenes.updated_at,
                scenes.revision, scenes.content_bytes AS size,
                scenes.element_count,
                scenes.tags_json, scenes.is_favorite, scenes.folder_id,
                scenes.last_opened_at, scenes.thumbnail_file_id, scenes.deleted_at,
                folders.name AS folder_name
         FROM scenes
         LEFT JOIN folders ON folders.id = scenes.folder_id
         WHERE scenes.id = ?`,
      ),
      touchSceneLastOpened: runtime.db.query(
        "UPDATE scenes SET last_opened_at = ? WHERE id = ?",
      ),
      getFolderById: runtime.db.query(
        "SELECT id, name, icon, color FROM folders WHERE id = ?",
      ),
      getFolderNameConflict: runtime.db.query(
        "SELECT id FROM folders WHERE trim(name) = ? AND id != ? LIMIT 1",
      ),
      getFileUpdatedAt: runtime.db.query(
        "SELECT updated_at FROM files WHERE id = ?",
      ),
      listFolders: runtime.db.query(
        `SELECT folders.id, folders.name, folders.icon, folders.color,
                folders.created_at, folders.updated_at,
                COUNT(scenes.id) AS scene_count
         FROM folders
         LEFT JOIN scenes
           ON scenes.folder_id = folders.id
          AND scenes.deleted_at IS NULL
         GROUP BY folders.id
         ORDER BY folders.name COLLATE NOCASE ASC`,
      ),
    };
    preparedStatementsMap.set(runtime, stmts);
  }
  return stmts;
};

export const createRequestHandler = (
  runtime: ServerRuntime,
  requestAddressResolver?: RequestAddressResolver,
) => {
  const stmts = getPreparedStatements(runtime);
  const assertSceneFolderExists = async (folderId: string | null) => {
    if (folderId && !(await stmts.getFolderById.get(folderId))) {
      throw new HttpError(400, "FOLDER_NOT_FOUND", "文件夹不存在");
    }
  };
  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const corsAllowed = isAllowedOrigin(runtime, req);

    if (req.method === "OPTIONS") {
      if (!corsAllowed) {
        return errorResponse(
          runtime,
          req,
          new HttpError(403, "CORS_FORBIDDEN", "不允许的跨域来源"),
        );
      }
      const headers = new Headers({
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Accept, X-Thumbnail-Version, If-None-Match",
        "Access-Control-Max-Age": "600",
      });
      const origin = req.headers.get("origin");
      if (origin && runtime.config.corsOrigins.has(origin)) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Access-Control-Allow-Credentials", "true");
        headers.set("Vary", "Origin");
      }
      return response(runtime, req, null, { status: 204, headers });
    }

    if (!corsAllowed) {
      return errorResponse(
        runtime,
        req,
        new HttpError(403, "CORS_FORBIDDEN", "不允许的跨域来源"),
      );
    }

    try {
      if (pathname === "/api/health" && req.method === "GET") {
        try {
          await stmts.healthCheck.get();
          if (runtime.filesDir && runtime.dbPath) {
            const fs = await import("node:fs");
            await fs.promises.access(runtime.filesDir, fs.constants.W_OK);
            await fs.promises.access(path.dirname(runtime.dbPath), fs.constants.W_OK);
          }
          // Keep health checks O(1). Full attachment consistency scans run in
          // the maintenance loop and are intentionally not exposed publicly.
          return jsonResponse(runtime, req, { status: "ok" });
        } catch {
          throw new HttpError(503, "STORAGE_UNAVAILABLE", "持久化存储不可用");
        }
      }

      if (pathname === "/api/auth/status" && req.method === "GET") {
        await cleanupExpiredSessions(runtime, Date.now());
        return jsonResponse(runtime, req, {
          authRequired:
            Boolean(runtime.config.authPassword) &&
            !runtime.config.allowAnonymous,
          authenticated: await isAuthorized(runtime, req),
        });
      }

      if (pathname === "/api/auth/verify" && req.method === "POST") {
        const rate = await consumeRateLimit(
          runtime,
          "auth",
          getClientKey(runtime, req, requestAddressResolver),
          runtime.config.authAttemptsPerWindow,
          AUTH_RATE_WINDOW_MS,
        );
        if (!rate.allowed) {
          return jsonResponse(
            runtime,
            req,
            { error: "认证尝试次数过多，请稍后再试", code: "RATE_LIMITED" },
            429,
            { "Retry-After": String(rate.retryAfter) },
          );
        }
        const body = requireJsonObject(
          await readJson(req, 64 * 1024, runtime.bodyMemoryBudget),
        );
        const password = body.password;
        if (
          runtime.config.allowAnonymous ||
          !runtime.config.authPassword ||
          await verifyPassword(password, runtime.config.authPassword)
        ) {
          return jsonResponse(runtime, req, { success: true }, 200, {
            "Set-Cookie": await issueSessionCookie(runtime, req),
          });
        }
        return jsonResponse(
          runtime,
          req,
          { error: "密码错误，请重新输入", code: "INVALID_PASSWORD" },
          401,
        );
      }

      if (pathname === "/api/auth/logout" && req.method === "POST") {
        const token = getSessionToken(runtime, req);
        if (token) {
          try {
            await runtime.db.run(
              "DELETE FROM sessions WHERE token = ?",
              [await hashSessionToken(runtime, token)],
            );
          } catch {
            // ignore
          }
        }
        const headers = new Headers({
          "Clear-Site-Data": '"cookies"',
        });
        for (const cookie of clearSessionCookies(runtime, req)) {
          headers.append("Set-Cookie", cookie);
        }
        return response(runtime, req, null, {
          status: 204,
          headers,
        });
      }

      if (pathname.startsWith("/api/") && !(await isAuthorized(runtime, req))) {
        return jsonResponse(
          runtime,
          req,
          { error: "请先完成访问授权", code: "AUTH_REQUIRED" },
          401,
        );
      }

      if (
        pathname.startsWith("/api/") &&
        ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)
      ) {
        const rateLimited = await writeRateLimitResponse(
          runtime,
          req,
          requestAddressResolver,
        );
        if (rateLimited) {
          return rateLimited;
        }
      }

      if (pathname === "/api/workspace/stats" && req.method === "GET") {
        return jsonResponse(runtime, req, await getWorkspaceStats(runtime));
      }

      if (pathname === "/api/scenes" && req.method === "GET") {
        return jsonResponse(runtime, req, await listScenePage(runtime, url, false));
      }

      if (pathname === "/api/scenes/trash" && req.method === "GET") {
        return jsonResponse(runtime, req, await listScenePage(runtime, url, true));
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
        const expectedStates: Array<typeof entries[number] & { deleted: boolean }> = [];
        for (const entry of entries) {
            const existing = await stmts.getSceneStateById.get(entry.id) as {
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
            expectedStates.push({ ...entry, deleted: existing.deleted_at !== null });
            if (isPermanent || (isRestore ? existing.deleted_at !== null : existing.deleted_at === null)) {
              changedEntries.push(entry);
            }
        }

        if (changedEntries.length) {
          // One statement makes the operation all-or-nothing even if a scene
          // changes after the initial validation query. Permanent deletion
          // relies on the scene_files foreign-key cascade in the same statement.
          const allEntriesJson = JSON.stringify(expectedStates);
          const changedIdsJson = JSON.stringify(changedEntries.map(({ id }) => id));
          const stateGuard = `(
            SELECT COUNT(*)
            FROM json_each(?) AS selected
            JOIN scenes ON scenes.id = json_extract(selected.value, '$.id')
            WHERE scenes.revision = CAST(json_extract(selected.value, '$.revision') AS INTEGER)
              AND (scenes.deleted_at IS NOT NULL) = CAST(json_extract(selected.value, '$.deleted') AS INTEGER)
          ) = ?`;
          const sql = isPermanent
            ? `DELETE FROM scenes
               WHERE id IN (SELECT value FROM json_each(?))
                 AND deleted_at IS NOT NULL
                 AND ${stateGuard}`
            : `UPDATE scenes
               SET deleted_at = ${isRestore ? "NULL" : "?"},
                   updated_at = ?, revision = revision + 1
               WHERE id IN (SELECT value FROM json_each(?))
                 AND deleted_at IS ${isRestore ? "NOT NULL" : "NULL"}
                 AND ${stateGuard}`;
          const values = isPermanent
            ? [changedIdsJson, allEntriesJson, entries.length]
            : isRestore
              ? [now, changedIdsJson, allEntriesJson, entries.length]
              : [now, now, changedIdsJson, allEntriesJson, entries.length];
          const result = await runtime.db.run(sql, values);
          if (result.changes !== changedEntries.length) {
            throw new HttpError(409, "SCENE_SELECTION_STALE", "选中的画板已发生变化，请刷新列表后重新选择");
          }
        }
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

      if (pathname === "/api/scenes" && req.method === "POST") {
        const body = requireJsonObject(
          await readJson(
            req,
            runtime.config.maxSceneBodyBytes,
            runtime.bodyMemoryBudget,
          ),
        );
        const id = body.id
          ? validateId(body.id, "scene")
          : `scene_${Date.now().toString(36)}_${randomHex(4)}`;
        const name = hasOwn(body, "name")
          ? validateName(body.name)
          : "未命名白板";
        const rawElements = hasOwn(body, "elements")
          ? validateElements(body.elements)
          : [];
        const elements = sanitizeSceneElements(rawElements);
        const appState = hasOwn(body, "appState")
          ? validateAppState(body.appState)
          : {};
        const { tags, favorite, folderId } = await parseSceneMetadata(runtime, body);
        const fileIds = extractFileIds(elements);
        const elementsJson = JSON.stringify(elements);
        const appStateJson = JSON.stringify(appState);
        const tagsJson = JSON.stringify(tags);
        const storedFieldBytes = [id, name, elementsJson, appStateJson, tagsJson, folderId || ""]
          .reduce((total, value) => total + new TextEncoder().encode(value).byteLength, D1_SCENE_METADATA_RESERVE_BYTES);
        if (storedFieldBytes > MAX_D1_SCENE_ROW_BYTES) {
          throw new HttpError(413, "SCENE_TOO_LARGE", "画板序列化内容超过 D1 单行安全限制");
        }
        const contentBytes = new TextEncoder().encode(elementsJson).byteLength;
        const now = Date.now();
        await withStorageMutationLock(runtime, async () => {
          await assertReferencedFilesExist(runtime, fileIds);
          try {
            await assertSceneFolderExists(folderId);
            const sceneInsert = {
              sql: `INSERT INTO scenes
                (id, name, elements, app_state, created_at, updated_at, revision,
                 tags_json, is_favorite, folder_id, element_count, content_bytes,
                 content_sha256)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
              values: [
                  id,
                  name,
                  elementsJson,
                  appStateJson,
                  now,
                  now,
                  tagsJson,
                  favorite ? 1 : 0,
                  folderId,
                  elements.length,
                  contentBytes,
                  await sha256Hex(elementsJson),
                ] as const,
            };
            const referenceMutations = await getSceneFileReferenceMutationStatements(runtime, id, fileIds);
            await runtime.db.batch([sceneInsert, ...referenceMutations]);
          } catch (error: any) {
            if (
              String(error?.message || "")
                .toLowerCase()
                .includes("unique")
            ) {
              throw new HttpError(409, "SCENE_EXISTS", "画板 ID 已存在");
            }
            throw error;
          }
        }, req.signal);
        publishSceneChanged(runtime, {
          type: "scene_changed",
          sceneId: id,
          revision: 1,
          updatedAt: now,
          changeKind: "created",
        });
        return jsonResponse(
          runtime,
          req,
          getSceneSummary({
            id,
            name,
            created_at: now,
            updated_at: now,
            revision: 1,
            size: contentBytes,
            element_count: elements.filter((el: any) => !el?.isDeleted).length,
            tags_json: tagsJson,
            is_favorite: favorite ? 1 : 0,
            folder_id: folderId,
            last_opened_at: null,
            thumbnail_file_id: null,
          }),
          201,
        );
      }

      if (
        pathname.startsWith("/api/folders") &&
        pathname === "/api/folders" &&
        req.method === "GET"
      ) {
        const folders = await stmts.listFolders.all();
        return jsonResponse(runtime, req, folders);
      }

      if (pathname === "/api/folders" && req.method === "POST") {
        const body = requireJsonObject(
          await readJson(req, 64 * 1024, runtime.bodyMemoryBudget),
        );
        const name = validateFolderName(body.name);
        const icon =
          body.icon === undefined ? "folder" : validateFolderIcon(body.icon);
        const color =
          body.color === undefined
            ? "#315f4c"
            : validateFolderColor(body.color);
        const id = `folder_${Date.now().toString(36)}_${randomHex(4)}`;
        const now = Date.now();
        try {
          const inserted = await runtime.db.run(
            `INSERT INTO folders (id, name, icon, color, created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM folders WHERE trim(name) = ?)`,
            [id, name, icon, color, now, now, name],
          );
          if (inserted.changes !== 1) {
            throw new HttpError(409, "FOLDER_NAME_EXISTS", "同名文件夹已存在，请使用已有文件夹或更换名称");
          }
        } catch (error: any) {
          if (error instanceof HttpError) throw error;
          if (
            String(error?.message || "")
              .toLowerCase()
              .includes("unique")
          ) {
            throw new HttpError(409, "FOLDER_EXISTS", "文件夹 ID 已存在");
          }
          throw error;
        }
        publishWorkspaceChanged(runtime, now);
        return jsonResponse(
          runtime,
          req,
          {
            id,
            name,
            icon,
            color,
            created_at: now,
            updated_at: now,
            scene_count: 0,
          },
          201,
        );
      }

      if (pathname.startsWith("/api/folders/") && req.method === "PATCH") {
        const id = getPathId(pathname, "/api/folders/", "scene");
        const body = requireJsonObject(
          await readJson(req, 64 * 1024, runtime.bodyMemoryBudget),
        );
        const name = validateFolderName(body.name);
        const existing = await stmts.getFolderById.get(id) as {
          id: string;
          name: string;
          icon: string;
          color: string;
        } | null;
        if (!existing) {
          throw new HttpError(404, "FOLDER_NOT_FOUND", "文件夹不存在");
        }
        const icon = hasOwn(body, "icon")
          ? validateFolderIcon(body.icon)
          : existing.icon;
        const color = hasOwn(body, "color")
          ? validateFolderColor(body.color)
          : existing.color;
        if (name === existing.name && icon === existing.icon && color === existing.color) {
          return jsonResponse(runtime, req, { success: true, ...(await getFolderSummary(runtime, id) as Record<string, unknown>), noop: true });
        }
        const now = Date.now();
        // Existing duplicates remain addressable by ID; only a rename must be unique.
        if (name !== existing.name && await stmts.getFolderNameConflict.get(name, id)) {
          throw new HttpError(409, "FOLDER_NAME_EXISTS", "同名文件夹已存在，请更换名称");
        }
        const updatedFolder = await runtime.db.run(
          `UPDATE folders SET name = ?, icon = ?, color = ?, updated_at = ?
           WHERE id = ? AND (? = name OR NOT EXISTS (SELECT 1 FROM folders WHERE trim(name) = ? AND id != ?))`,
          [name, icon, color, now, id, name, name, id],
        );
        if (updatedFolder.changes !== 1) {
          throw new HttpError(409, "FOLDER_NAME_EXISTS", "同名文件夹已存在，请更换名称");
        }
        const updated = await getFolderSummary(runtime, id);
        if (!updated) {
          throw new HttpError(404, "FOLDER_NOT_FOUND", "文件夹不存在");
        }
        publishWorkspaceChanged(runtime, now);
        return jsonResponse(runtime, req, {
          success: true,
          ...updated,
        });
      }

      if (pathname.startsWith("/api/folders/") && req.method === "DELETE") {
        const id = getPathId(pathname, "/api/folders/", "scene");
        const existing = await stmts.getFolderById.get(id);
        if (!existing) {
          return jsonResponse(runtime, req, {
            success: true,
            id,
            deleted: false,
          });
        }
        const affectedScenes = await runtime.db
          .query("SELECT id, revision, updated_at FROM scenes WHERE folder_id = ?")
          .all(id) as Array<{
          id: string;
          revision: number;
          updated_at: number;
        }>;
        const now = affectedScenes.reduce(
          (latest, scene) => Math.max(latest, Number(scene.updated_at) + 1),
          Date.now(),
        );
        const folderDeleteStatements = affectedScenes.map((scene) => ({
          sql: `UPDATE scenes SET folder_id = NULL, updated_at = ?, revision = ? WHERE id = ? AND folder_id = ?`,
          values: [now, storedSceneRevision(scene.revision) + 1, scene.id, id],
        }));
        folderDeleteStatements.push({ sql: "DELETE FROM folders WHERE id = ?", values: [id] });
        await runtime.db.batch(folderDeleteStatements);
        for (const scene of affectedScenes) {
          publishSceneChanged(runtime, {
            type: "scene_changed",
            sceneId: scene.id,
            revision: storedSceneRevision(scene.revision) + 1,
            updatedAt: now,
            changeKind: "metadata",
          });
        }
        publishWorkspaceChanged(runtime, now);
        return jsonResponse(runtime, req, { success: true, id, deleted: true });
      }

      if (
        pathname.startsWith("/api/scenes/") &&
        pathname.endsWith("/restore") &&
        req.method === "POST"
      ) {
        const id = getPathId(
          pathname.slice(0, -"/restore".length),
          "/api/scenes/",
          "scene",
        );
        const existing = await stmts.getSceneStateById.get(id) as {
          id: string;
          deleted_at: number | null;
          revision: number;
        } | null;
        if (!existing) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在");
        }
        if (existing.deleted_at === null) {
          return jsonResponse(runtime, req, {
            success: true,
            id,
            restored: false,
            revision: storedSceneRevision(existing.revision),
            noop: true,
          });
        }
        const updatedAt = Date.now();
        const revision = storedSceneRevision(existing.revision) + 1;
        await stmts.restoreScene.run(updatedAt, id, revision - 1);
        publishSceneChanged(runtime, {
          type: "scene_changed",
          sceneId: id,
          revision,
          updatedAt,
          changeKind: "restored",
        });
        return jsonResponse(runtime, req, {
          success: true,
          id,
          restored: true,
          revision,
        });
      }

      if (
        pathname.startsWith("/api/scenes/") &&
        pathname.endsWith("/summary") &&
        req.method === "GET"
      ) {
        const id = getPathId(
          pathname.slice(0, -"/summary".length),
          "/api/scenes/",
          "scene",
        );
        const row = await stmts.getSceneSummaryById.get(id);
        if (!row) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在");
        }
        return jsonResponse(runtime, req, getSceneSummary(row));
      }

      if (pathname.startsWith("/api/scenes/") && req.method === "GET") {
        const id = getPathId(pathname, "/api/scenes/", "scene");
        const versionRow = await stmts.getSceneVersionById.get(id) as {
          id: string;
          revision: number;
          updated_at: number;
          thumbnail_file_id: string | null;
          last_opened_at: number | null;
        } | null;
        if (!versionRow) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
        }
        const sceneRevision = storedSceneRevision(versionRow.revision);
        const sceneUpdatedAt = Number(versionRow.updated_at) || 0;
        const etag = `"scene-${await sha256Hex(
          JSON.stringify([
            id,
            sceneRevision,
            sceneUpdatedAt,
            versionRow.thumbnail_file_id,
            versionRow.last_opened_at,
          ]),
        )}"`;
        const ifNoneMatch = req.headers.get("if-none-match");
        if (
          ifNoneMatch
            ?.split(",")
            .map((value) => value.trim())
            .some((value) => value === etag || value === "*")
        ) {
          return response(runtime, req, null, {
            status: 304,
            headers: {
              ETag: etag,
              "Cache-Control": "private, no-cache",
            },
          });
        }
        const row = await stmts.getSceneRawById.get(id);
        if (!row) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
        }
        return jsonResponse(runtime, req, parseStoredScene(row), 200, {
          ETag: etag,
          "Cache-Control": "private, no-cache",
        });
      }

      if (
        pathname.startsWith("/api/scenes/") &&
        pathname.endsWith("/open") &&
        req.method === "POST"
      ) {
        const id = getPathId(
          pathname.slice(0, -"/open".length),
          "/api/scenes/",
          "scene",
        );
        const existing = await stmts.getSceneById.get(id);
        if (!existing) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
        }
        const lastOpenedAt = Date.now();
        await stmts.touchSceneLastOpened.run(lastOpenedAt, id);
        return jsonResponse(runtime, req, { success: true, id, lastOpenedAt });
      }

      if (
        pathname.startsWith("/api/scenes/") &&
        pathname.endsWith("/thumbnail") &&
        req.method === "PUT"
      ) {
        const id = getPathId(
          pathname.slice(0, -"/thumbnail".length),
          "/api/scenes/",
          "scene",
        );
        const existing = await stmts.getSceneById.get(id);
        if (!existing) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
        }
        const sceneRevision = Number(
          (await stmts.getSceneRevision.get(id) as { revision: number } | null)
            ?.revision,
        ) || 1;
        const rawContentType = req.headers.get("content-type") || "";
        const contentType = rawContentType.split(";")[0].trim().toLowerCase();
        if (
          contentType !== "image/png" &&
          contentType !== "image/jpeg" &&
          contentType !== "image/webp"
        ) {
          throw new HttpError(
            415,
            "UNSUPPORTED_THUMBNAIL_TYPE",
            "画板缩略图必须是 PNG、JPEG 或 WebP",
          );
        }
        const thumbnailId = `thumbnail_${await sha256Hex(id)}`;
        const thumbnailVersion = parseThumbnailVersion(req);
        const revisionParam = url.searchParams.get("revision");
        const expectedRevision = revisionParam === null
          ? undefined
          : requireRevision(Number(revisionParam));
        return await withThumbnailWriteLock(thumbnailId, async () => {
          if (expectedRevision !== undefined) {
            const current = await stmts.getSceneVersionById.get(id) as {
              revision: number; thumbnail_file_id: string | null;
            } | null;
            if (!current || current.revision !== expectedRevision) {
              throw new HttpError(409, "REVISION_CONFLICT", "画板内容已更新，请重新生成预览");
            }
            // Another tab may have repaired the same board while this upload waited.
            if (current.thumbnail_file_id) {
              return jsonResponse(runtime, req, {
                success: true, id, thumbnail_file_id: current.thumbnail_file_id,
              });
            }
          }
          const currentThumbnail = await stmts.getFileUpdatedAt.get(thumbnailId) as
            | { updated_at: number }
            | null;
          if (
            thumbnailVersion !== undefined &&
            currentThumbnail &&
            Number(currentThumbnail.updated_at) >= thumbnailVersion
          ) {
            return jsonResponse(runtime, req, {
              success: true,
              id,
              thumbnail_file_id: thumbnailId,
              stale: true,
            });
          }
          const prepared = await stageRequestBodyToFile(runtime, thumbnailId, req);
          await upsertStagedFile(
            runtime,
            thumbnailId,
            contentType,
            prepared,
            undefined,
            thumbnailVersion,
          );
          const linked = await runtime.db.run(
            `UPDATE scenes SET thumbnail_file_id = ? WHERE id = ? AND deleted_at IS NULL
             AND (? IS NULL OR revision = ?)`,
            [thumbnailId, id, expectedRevision ?? null, expectedRevision ?? null],
          );
          if (linked.changes !== 1) {
            throw new HttpError(409, "REVISION_CONFLICT", "画板内容已更新，请重新生成预览");
          }
          publishSceneChanged(runtime, {
            type: "scene_changed",
            sceneId: id,
            revision: sceneRevision,
            updatedAt: Date.now(),
            changeKind: "thumbnail",
          });
          return jsonResponse(runtime, req, {
            success: true,
            id,
            thumbnail_file_id: thumbnailId,
          });
        });
      }

      if (
        pathname.startsWith("/api/scenes/") &&
        pathname.endsWith("/thumbnail") &&
        req.method === "DELETE"
      ) {
        const id = getPathId(
          pathname.slice(0, -"/thumbnail".length),
          "/api/scenes/",
          "scene",
        );
        const existing = await stmts.getSceneThumbnailById.get(id) as {
          id: string;
          thumbnail_file_id: string | null;
        } | null;
        if (!existing) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
        }
        const sceneRevision = Number(
          (await stmts.getSceneRevision.get(id) as { revision: number } | null)
            ?.revision,
        ) || 1;
        const thumbnailId = `thumbnail_${await sha256Hex(id)}`;
        const thumbnailVersion = parseThumbnailVersion(req);
        return await withThumbnailWriteLock(thumbnailId, async () => {
          const currentThumbnail = await stmts.getFileUpdatedAt.get(thumbnailId) as
            | { updated_at: number }
            | null;
          if (
            thumbnailVersion !== undefined &&
            currentThumbnail &&
            Number(currentThumbnail.updated_at) >= thumbnailVersion
          ) {
            return jsonResponse(runtime, req, {
              success: true,
              id,
              thumbnail_file_id: existing.thumbnail_file_id,
              stale: true,
            });
          }
          await runtime.db.run(
            "UPDATE scenes SET thumbnail_file_id = NULL WHERE id = ?",
            [id],
          );
          if (currentThumbnail && thumbnailVersion !== undefined) {
            await runtime.db.run("UPDATE files SET updated_at = ? WHERE id = ?", [
              thumbnailVersion,
              thumbnailId,
            ]);
          }
          publishSceneChanged(runtime, {
            type: "scene_changed",
            sceneId: id,
            revision: sceneRevision,
            updatedAt: Date.now(),
            changeKind: "thumbnail",
          });
          return jsonResponse(runtime, req, {
            success: true,
            id,
            thumbnail_file_id: null,
          });
        });
      }

      if (pathname.startsWith("/api/scenes/") && req.method === "PATCH") {
        const id = getPathId(pathname, "/api/scenes/", "scene");
        const body = requireJsonObject(
          await readJson(req, 64 * 1024, runtime.bodyMemoryBudget),
        );
        if (
          !["name", "tags", "favorite", "folder_id"].some((key) =>
            hasOwn(body, key),
          )
        ) {
          throw new HttpError(400, "INVALID_METADATA", "没有可更新的画板信息");
        }
        const baseRevision = requireRevision(body.baseRevision);
        const existing = await stmts.getSceneMetadataById.get(id) as {
          name: string;
          tags_json: string;
          is_favorite: number;
          folder_id: string | null;
          revision: number;
        } | null;
        if (!existing) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
        }
        const currentRevision = storedSceneRevision(existing.revision);
        if (baseRevision !== undefined && baseRevision !== currentRevision) {
          throw new HttpError(
            409,
            "REVISION_CONFLICT",
            "云端画板已被其他操作更新",
          );
        }
        const { name, tags, favorite, folderId } = await parseSceneMetadata(
          runtime,
          body,
          existing,
        );
        const currentTags = JSON.parse(existing.tags_json) as string[];
        if (name === existing.name && favorite === Boolean(existing.is_favorite) && folderId === existing.folder_id && tags.length === currentTags.length && tags.every((tag) => currentTags.includes(tag))) {
          return jsonResponse(runtime, req, { ...getSceneSummary(await stmts.getSceneSummaryById.get(id)), noop: true });
        }
        const now = Date.now();
        const revision = currentRevision + 1;
        await assertSceneFolderExists(folderId);
        const result = await runtime.db.run(
            `UPDATE scenes
             SET name = ?, tags_json = ?, is_favorite = ?, folder_id = ?,
                 updated_at = ?, revision = ?
             WHERE id = ? AND deleted_at IS NULL AND revision = ?`,
            [
              name,
              JSON.stringify(tags),
              favorite ? 1 : 0,
              folderId,
              now,
              revision,
              id,
              currentRevision,
            ],
          );
        if (result.changes !== 1) {
          throw new HttpError(
              409,
              "REVISION_CONFLICT",
              "云端画板已被其他操作更新",
            );
        }
        const updated = await stmts.getSceneSummaryById.get(id);
        publishSceneChanged(runtime, {
          type: "scene_changed",
          sceneId: id,
          revision,
          updatedAt: now,
          changeKind: "metadata",
        });
        return jsonResponse(runtime, req, getSceneSummary(updated));
      }

      if (pathname.startsWith("/api/scenes/") && req.method === "PUT") {
        const id = getPathId(pathname, "/api/scenes/", "scene");
        const body = requireJsonObject(
          await readJson(
            req,
            runtime.config.maxSceneBodyBytes,
            runtime.bodyMemoryBudget,
          ),
        );
        const existing = await stmts.getSceneRawById.get(id) as any;
        if (!existing) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
        }
        const baseRevision = requireRevision(body.baseRevision);
        const currentRevision = storedSceneRevision(existing.revision);
        if (baseRevision !== undefined && baseRevision !== currentRevision) {
          throw new HttpError(
            409,
            "REVISION_CONFLICT",
            "云端画板已被其他设备更新",
          );
        }
        const { name, tags, favorite, folderId } = await parseSceneMetadata(
          runtime,
          body,
          existing,
        );
        const rawElements = hasOwn(body, "elements")
          ? validateElements(body.elements)
          : parseStoredElements(existing.elements);
        const elements = sanitizeSceneElements(rawElements);
        const appState = hasOwn(body, "appState")
          ? validateAppState(body.appState)
          : parseStoredAppState(existing.app_state);
        const fileIds = extractFileIds(elements);
        const elementsJson = JSON.stringify(elements);
        const appStateJson = JSON.stringify(appState);
        const tagsJson = JSON.stringify(tags);
        const elementCount = elements.length;
        const contentBytes = new TextEncoder().encode(elementsJson).byteLength;
        const contentSha256 = await sha256Hex(elementsJson);
        const storedFieldBytes = [id, name, elementsJson, appStateJson, tagsJson, folderId || ""]
          .reduce((total, value) => total + new TextEncoder().encode(value).byteLength, D1_SCENE_METADATA_RESERVE_BYTES);
        if (storedFieldBytes > MAX_D1_SCENE_ROW_BYTES) {
          throw new HttpError(413, "SCENE_TOO_LARGE", "画板序列化内容超过 D1 单行安全限制");
        }
        const contentChanged = existing.elements !== elementsJson || existing.app_state !== appStateJson;
        const isUnchanged =
          existing.name === name &&
          existing.elements === elementsJson &&
          existing.app_state === appStateJson &&
          existing.tags_json === tagsJson &&
          Boolean(existing.is_favorite) === favorite &&
          (existing.folder_id || null) === folderId;
        if (isUnchanged) {
          return jsonResponse(runtime, req, {
            success: true,
            id,
            updated_at: existing.updated_at,
            revision: currentRevision,
            unchanged: true,
          });
        }
        const now = Date.now();
        const revision = currentRevision + 1;
        await withStorageMutationLock(runtime, async () => {
          await assertSceneFolderExists(folderId);
          await assertReferencedFilesExist(runtime, fileIds);
          const referenceMutations = await getSceneFileReferenceMutationStatements(
            runtime,
            id,
            fileIds,
            revision,
            contentSha256,
          );
          const [result] = await runtime.db.batch([
            {
              sql: `UPDATE scenes
             SET name = ?, elements = ?, app_state = ?, tags_json = ?,
                 is_favorite = ?, folder_id = ?, updated_at = ?, revision = ?,
                 element_count = ?, content_bytes = ?, content_sha256 = ?,
                 thumbnail_file_id = CASE WHEN ? THEN NULL ELSE thumbnail_file_id END
             WHERE id = ? AND deleted_at IS NULL AND revision = ?`,
              values: [
              name,
              elementsJson,
              appStateJson,
              tagsJson,
              favorite ? 1 : 0,
              folderId,
              now,
              revision,
              elementCount,
              contentBytes,
              contentSha256,
              contentChanged ? 1 : 0,
              id,
              currentRevision,
              ],
            },
            ...referenceMutations,
          ]);
          if (result.changes !== 1) {
            throw new HttpError(
              409,
              "REVISION_CONFLICT",
              "云端画板已被其他设备更新",
            );
          }
        }, req.signal);
        publishSceneChanged(runtime, {
          type: "scene_changed",
          sceneId: id,
          revision,
          updatedAt: now,
          changeKind: "content",
        });
        return jsonResponse(runtime, req, {
          success: true,
          id,
          updated_at: now,
          revision,
        });
      }

      if (pathname === "/api/scenes/trash" && req.method === "DELETE") {
        const result = await runtime.db.run(
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

      if (pathname.startsWith("/api/scenes/") && req.method === "DELETE") {
        const id = getPathId(pathname, "/api/scenes/", "scene");
        const existing = await stmts.getSceneStateById.get(id) as {
          id: string;
          deleted_at: number | null;
          revision: number;
        } | null;
        if (!existing) {
          return jsonResponse(runtime, req, {
            success: true,
            id,
            deleted: false,
          });
        }
        const isPermanent = url.searchParams.get("permanent") === "true";
        if (isPermanent) {
          await runtime.db.batch([
            { sql: "DELETE FROM scene_files WHERE scene_id = ?", values: [id] },
            { sql: "DELETE FROM scenes WHERE id = ?", values: [id] },
          ]);
          publishSceneChanged(runtime, {
            type: "scene_changed",
            sceneId: id,
            revision: storedSceneRevision(existing.revision),
            updatedAt: Date.now(),
            changeKind: "deleted",
          });
          return jsonResponse(runtime, req, {
            success: true,
            id,
            deleted: true,
            permanent: true,
          });
        }
        if (existing.deleted_at !== null) {
          return jsonResponse(runtime, req, {
            success: true,
            id,
            deleted: true,
            permanent: false,
            deleted_at: Number(existing.deleted_at),
            revision: storedSceneRevision(existing.revision),
            noop: true,
          });
        }
        const now = Date.now();
        const revision = storedSceneRevision(existing.revision) + 1;
        await stmts.softDeleteScene.run(now, now, id, revision - 1);
        publishSceneChanged(runtime, {
          type: "scene_changed",
          sceneId: id,
          revision,
          updatedAt: now,
          changeKind: "deleted",
        });
        return jsonResponse(runtime, req, {
          success: true,
          id,
          deleted: true,
          permanent: false,
          deleted_at: now,
          revision,
        });
      }

      if (pathname.startsWith("/api/files/") && req.method === "PUT") {
        const id = getPathId(pathname, "/api/files/", "file");
        const contentType = req.headers.get("content-type");
        if (!contentType) {
          throw new HttpError(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "文件上传必须指定 MIME 类型",
          );
        }
        const mimeType = validateMimeType(contentType);
        const prepared = await stageRequestBodyToFile(runtime, id, req);
        const file = await upsertStagedFile(runtime, id, mimeType, prepared);
        return jsonResponse(runtime, req, { success: true, file }, 201, {
          ETag: `"${file.sha256}"`,
        });
      }

      if (pathname.startsWith("/api/files/") && req.method === "GET") {
        const id = getPathId(pathname, "/api/files/", "file");
        const row = await getStoredFileMetadata(runtime, id);
        if (!row?.storage_path) {
          throw new HttpError(404, "FILE_NOT_FOUND", "文件不存在");
        }
        const fileObject = await getFileObject(runtime, id);
        if (!fileObject) {
          throw new HttpError(404, "FILE_NOT_FOUND", "文件不存在");
        }

        const etag = row.sha256 ? `"${row.sha256}"` : undefined;
        const ifNoneMatch = req.headers.get("if-none-match");
        // File IDs can be overwritten by PUT, so clients must revalidate even
        // when the response carries a content hash ETag.
        const cacheControl = "private, no-cache";

        if (etag && ifNoneMatch) {
          const clientEtags = ifNoneMatch
            .split(",")
            .map((item) => item.trim());
          if (clientEtags.includes(etag) || clientEtags.includes("*")) {
            return response(runtime, req, null, {
              status: 304,
              headers: {
                ETag: etag,
                "Cache-Control": cacheControl,
              },
            });
          }
        }

        if (String(row.mime_type).toLowerCase() === "image/svg+xml") {
          return response(runtime, req, fileObject.body, {
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": `attachment; filename="${id}"`,
              "Content-Length": String(row.byte_size),
              "X-File-Created-At": String(row.created_at),
              "Cache-Control": "private, no-store",
              ...(etag ? { ETag: etag } : {}),
            },
          });
        }

        const responseHeaders: Record<string, string> = {
          "Content-Type": row.mime_type,
          "Content-Length": String(row.byte_size),
          "X-File-Created-At": String(row.created_at),
          "Cache-Control": cacheControl,
        };
        if (etag) {
          responseHeaders.ETag = etag;
        }

        return response(runtime, req, fileObject.body, {
          headers: responseHeaders,
        });
      }

      if (pathname.startsWith("/api/")) {
        throw new HttpError(404, "NOT_FOUND", "接口不存在");
      }

      if (runtime.staticAssets) {
        return runtime.staticAssets.fetch(req);
      }
      if (!runtime.staticDir) throw new HttpError(404, "STATIC_NOT_FOUND", "资源不存在");
      let decodedPath: string;
      try { decodedPath = decodeURIComponent(pathname); }
      catch { throw new HttpError(400, "INVALID_PATH", "无效的资源路径"); }
      const staticDir = path.resolve(runtime.staticDir);
      const staticPath = path.resolve(staticDir, `.${decodedPath === "/" ? "/index.html" : decodedPath}`);
      if (staticPath !== staticDir && !staticPath.startsWith(`${staticDir}${path.sep}`)) {
        throw new HttpError(400, "INVALID_PATH", "无效的资源路径");
      }
      let staticFile = Bun.file(staticPath);
      let responsePath = pathname;
      let contentType: string | undefined;
      if (!(await staticFile.exists()) && (req.headers.get("accept") || "").includes("text/html")) {
        const indexPath = path.join(staticDir, "index.html");
        const indexFile = Bun.file(indexPath);
        if (await indexFile.exists()) {
          staticFile = indexFile;
          responsePath = "/index.html";
          contentType = "text/html; charset=utf-8";
        }
      }
      if (await staticFile.exists()) {
        const fileBytes = new Uint8Array(await staticFile.arrayBuffer());
        const etag = `"${await sha256Hex(fileBytes)}"`;
        const filename = path.posix.basename(responsePath);
        const hashedAsset = /^(?:chunk-[a-z0-9]+|.+-[a-z0-9]{8,})\.[a-z0-9]+$/i.test(filename);
        const cacheControl = responsePath === "/" || responsePath.endsWith("/index.html") || responsePath === "/manifest.webmanifest" || responsePath.startsWith("/locales/")
          ? "no-cache"
          : responsePath.startsWith("/assets/") || responsePath.startsWith("/fonts/") || hashedAsset
          ? "public, max-age=31536000, immutable"
          : "public, max-age=3600";
        const headers = {
          "Content-Type": contentType || staticFile.type || "application/octet-stream",
          "Content-Length": String(fileBytes.byteLength),
          "Cache-Control": cacheControl,
          ETag: etag,
        };
        if (req.headers.get("if-none-match")?.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === etag || candidate.trim() === "*")) {
          return response(runtime, req, null, { status: 304, headers });
        }
        return response(runtime, req, fileBytes, { headers });
      }
      throw new HttpError(404, "STATIC_NOT_FOUND", "资源不存在");
    } catch (error) {
      return errorResponse(runtime, req, error);
    } finally {
      releaseJsonBodyMemoryBudget(req);
    }
  };

  return handler;
};
