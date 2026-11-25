import { WRITE_RATE_WINDOW_MS, WRITE_REQUESTS_PER_WINDOW } from "./config";
import { randomHex } from "./crypto";
import { HttpError } from "./errors";
import { isMcpCreateSession } from "./create-idempotency";
import { consumeRateLimit, getClientKey, getSessionToken } from "./auth";
import { jsonResponse } from "./http";
import { hasOwn, validateFolderName } from "./validation";

import type { RequestAddressResolver, ServerRuntime } from "./types";

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

export type RouteStatements = NonNullable<
  ReturnType<typeof preparedStatementsMap.get>
>;

export type RouteContext = {
  runtime: ServerRuntime;
  req: Request;
  url: URL;
  pathname: string;
  stmts: RouteStatements;
  requestAddressResolver?: RequestAddressResolver;
};

export const getPreparedStatements = (
  runtime: ServerRuntime,
): RouteStatements => {
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
        `SELECT id, name, tags_json, is_favorite, folder_id, revision, updated_at
         FROM scenes
         WHERE id = ? AND deleted_at IS NULL`,
      ),
      getSceneStateById: runtime.db.query(
        "SELECT id, deleted_at, revision, updated_at FROM scenes WHERE id = ?",
      ),
      softDeleteScene: runtime.db.query(
        `UPDATE scenes SET deleted_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
      ),
      restoreScene: runtime.db.query(
        `UPDATE scenes SET deleted_at = NULL, revision = revision + 1
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
        "SELECT id FROM folders WHERE name = ? AND id != ? LIMIT 1",
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

export const assertSceneFolderExists = (
  stmts: RouteStatements,
  folderId: string | null,
) => {
  if (folderId && !stmts.getFolderById.get(folderId)) {
    throw new HttpError(400, "FOLDER_NOT_FOUND", "文件夹不存在");
  }
};

export const parseMcpFolderName = (
  runtime: ServerRuntime,
  req: Request,
  body: Record<string, unknown>,
) => {
  if (!hasOwn(body, "folder_name")) return undefined;
  if (
    hasOwn(body, "folder_id") ||
    !isMcpCreateSession(runtime, getSessionToken(runtime, req))
  ) {
    throw new HttpError(400, "INVALID_FOLDER", "无效的文件夹选择");
  }
  return validateFolderName(body.folder_name);
};

export const resolveSceneFolder = (
  runtime: ServerRuntime,
  stmts: RouteStatements,
  folderId: string | null,
  name?: string,
) => {
  if (name === undefined) {
    assertSceneFolderExists(stmts, folderId);
    return folderId;
  }
  const existing = stmts.getFolderNameConflict.get(name, "") as {
    id: string;
  } | null;
  if (existing) return existing.id;
  const now = Date.now();
  const id = `folder_${now.toString(36)}_${randomHex(4)}`;
  runtime.db.run(
    "INSERT INTO folders (id, name, icon, color, created_at, updated_at) VALUES (?, ?, 'folder', '#315f4c', ?, ?)",
    [id, name, now, now],
  );
  return id;
};

export const publishSceneChanged = (
  runtime: ServerRuntime,
  event: Parameters<
    NonNullable<ServerRuntime["realtime"]>["publishSceneChanged"]
  >[0],
) => runtime.realtime?.publishSceneChanged(event);

export const publishWorkspaceChanged = (
  runtime: ServerRuntime,
  updatedAt?: number,
  changeKind?: "opened",
) => runtime.realtime?.publishWorkspaceChanged(updatedAt, changeKind);

export const writeRateLimitResponse = (
  runtime: ServerRuntime,
  req: Request,
  requestAddressResolver?: RequestAddressResolver,
) => {
  const sessionToken = getSessionToken(runtime, req);
  if (sessionToken && isMcpCreateSession(runtime, sessionToken)) {
    return null;
  }
  const rate = consumeRateLimit(
    runtime.writeAttempts,
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
