import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  AUTH_RATE_WINDOW_MS,
  WRITE_RATE_WINDOW_MS,
  WRITE_REQUESTS_PER_WINDOW,
} from "./config";
import { handleDevReloadRequest } from "./dev-reload";
import { HttpError } from "./errors";
import {
  cleanupExpiredSessions,
  clearSessionCookies,
  consumeRateLimit,
  getClientKey,
  getSessionToken,
  hashSessionToken,
  isAuthorized,
  issueSessionCookie,
  verifyPassword,
} from "./auth";
import { createDatabaseSnapshot, createFullBackup } from "./backup";
import {
  assertReferencedFilesExist,
  decodeDataUrl,
  extractFileIds,
  fileExists,
  getFilePath,
  syncSceneFileReferences,
  upsertFile,
  withThumbnailWriteLock,
} from "./files";
import {
  errorResponse,
  isAllowedOrigin,
  jsonResponse,
  readBody,
  readJson,
  response,
} from "./http";
import { getSceneSummary, parseSceneMetadata, parseStoredScene } from "./scenes";
import {
  buildStaticPath,
  getStaticCacheControl,
  getStaticDir,
} from "./static";
import {
  hasOwn,
  parseFileUploadEntries,
  requireJsonObject,
  requireRevision,
  validateAppState,
  validateElements,
  validateFolderName,
  getPathId,
  validateId,
  validateMimeType,
  validateName,
} from "./validation";

import type { RequestAddressResolver, ServerRuntime } from "./types";

const getFolderSummary = (runtime: ServerRuntime, id: string) =>
  runtime.db
    .query(
      `SELECT folders.id, folders.name, folders.created_at, folders.updated_at,
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
    touchSceneLastOpened: ReturnType<ServerRuntime["db"]["query"]>;
    getFolderById: ReturnType<ServerRuntime["db"]["query"]>;
    getFileUpdatedAt: ReturnType<ServerRuntime["db"]["query"]>;
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
      touchSceneLastOpened: runtime.db.query(
        "UPDATE scenes SET last_opened_at = ? WHERE id = ?",
      ),
      getFolderById: runtime.db.query("SELECT id FROM folders WHERE id = ?"),
      getFileUpdatedAt: runtime.db.query(
        "SELECT updated_at FROM files WHERE id = ?",
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
          "Content-Type, Accept, X-Thumbnail-Version",
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

    if (pathname === "/__dev_reload" && req.method !== "GET") {
      return response(runtime, req, null, {
        status: 405,
        headers: { Allow: "GET" },
      });
    }

    try {
      if (pathname === "/api/health" && req.method === "GET") {
        try {
          stmts.healthCheck.get();
          fs.accessSync(path.dirname(runtime.dbPath), fs.constants.W_OK);
          fs.accessSync(runtime.filesDir, fs.constants.W_OK);
          // Keep health checks O(1). Full attachment consistency scans run in
          // the maintenance loop and are intentionally not exposed publicly.
          return jsonResponse(runtime, req, { status: "ok" });
        } catch {
          throw new HttpError(503, "STORAGE_UNAVAILABLE", "持久化存储不可用");
        }
      }

      if (pathname === "/api/backup/full" && req.method === "GET") {
        if (!isAuthorized(runtime, req)) {
          return jsonResponse(
            runtime,
            req,
            { error: "请先完成访问授权", code: "AUTH_REQUIRED" },
            401,
          );
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        try {
          const archive = await createFullBackup(runtime, timestamp);
          return response(runtime, req, archive, {
            headers: {
              "Content-Type": "application/x-tar",
              "Content-Disposition": `attachment; filename="excalidraw-full-backup-${timestamp}.tar"`,
              "Cache-Control": "no-store",
            },
          });
        } catch (error: any) {
          throw new HttpError(
            500,
            "BACKUP_FAILED",
            `创建完整备份失败: ${error?.message || "未知错误"}`,
          );
        }
      }

      if (pathname === "/api/backup/snapshot" && req.method === "GET") {
        if (!isAuthorized(runtime, req)) {
          return jsonResponse(
            runtime,
            req,
            { error: "请先完成访问授权", code: "AUTH_REQUIRED" },
            401,
          );
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        try {
          const snapshot = await createDatabaseSnapshot(runtime, timestamp);
          try {
            const backupBytes = await Bun.file(
              snapshot.tempBackupFile,
            ).arrayBuffer();
            return response(runtime, req, backupBytes, {
              headers: {
                "Content-Type": "application/x-sqlite3",
                "Content-Disposition": `attachment; filename="excalidraw-backup-${timestamp}.db"`,
                "Cache-Control": "no-store",
              },
            });
          } finally {
            await snapshot.cleanup().catch(() => {});
          }
        } catch (error: any) {
          throw new HttpError(
            500,
            "BACKUP_FAILED",
            `创建数据库热备失败: ${error?.message || "未知错误"}`,
          );
        }
      }

      if (pathname === "/api/auth/status" && req.method === "GET") {
        cleanupExpiredSessions(runtime, Date.now());
        return jsonResponse(runtime, req, {
          authRequired:
            Boolean(runtime.config.authPassword) &&
            !runtime.config.allowAnonymous,
          authenticated: isAuthorized(runtime, req),
        });
      }

      if (pathname === "/api/auth/verify" && req.method === "POST") {
        const rate = consumeRateLimit(
          runtime.authAttempts,
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
        const body = requireJsonObject(await readJson(req, 64 * 1024));
        const password = body.password;
        if (
          runtime.config.allowAnonymous ||
          !runtime.config.authPassword ||
          verifyPassword(password, runtime.config.authPassword)
        ) {
          return jsonResponse(runtime, req, { success: true }, 200, {
            "Set-Cookie": issueSessionCookie(runtime, req),
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
          runtime.sessions.delete(token);
          try {
            runtime.db.run(
              "DELETE FROM sessions WHERE token = ? OR token = ?",
              [hashSessionToken(runtime, token), token],
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

      if (pathname.startsWith("/api/") && !isAuthorized(runtime, req)) {
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
        const rate = consumeRateLimit(
          runtime.writeAttempts,
          getClientKey(runtime, req, requestAddressResolver),
          WRITE_REQUESTS_PER_WINDOW,
          WRITE_RATE_WINDOW_MS,
        );
        if (!rate.allowed) {
          return jsonResponse(
            runtime,
            req,
            { error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" },
            429,
            { "Retry-After": String(rate.retryAfter) },
          );
        }
      }

      if (pathname === "/api/scenes" && req.method === "GET") {
        const rows = runtime.db
          .query(
            `SELECT scenes.id, scenes.name, scenes.created_at, scenes.updated_at,
                    scenes.revision, length(scenes.elements) AS size,
                    CASE WHEN json_valid(scenes.elements) = 1
                         THEN (SELECT COUNT(*) FROM json_each(scenes.elements) WHERE COALESCE(json_extract(value, '$.isDeleted'), 0) NOT IN (1, 1=1, 'true'))
                         ELSE 0 END AS element_count,
                    scenes.tags_json, scenes.is_favorite, scenes.folder_id,
                    scenes.last_opened_at, scenes.thumbnail_file_id, scenes.deleted_at,
                    folders.name AS folder_name
             FROM scenes
             LEFT JOIN folders ON folders.id = scenes.folder_id
             WHERE scenes.deleted_at IS NULL
             ORDER BY scenes.updated_at DESC`,
          )
          .all()
          .map(getSceneSummary);
        return jsonResponse(runtime, req, rows);
      }

      if (pathname === "/api/scenes/trash" && req.method === "GET") {
        const rows = runtime.db
          .query(
            `SELECT scenes.id, scenes.name, scenes.created_at, scenes.updated_at,
                    scenes.revision, length(scenes.elements) AS size,
                    CASE WHEN json_valid(scenes.elements) = 1
                         THEN (SELECT COUNT(*) FROM json_each(scenes.elements) WHERE COALESCE(json_extract(value, '$.isDeleted'), 0) NOT IN (1, 1=1, 'true'))
                         ELSE 0 END AS element_count,
                    scenes.tags_json, scenes.is_favorite, scenes.folder_id,
                    scenes.last_opened_at, scenes.thumbnail_file_id, scenes.deleted_at,
                    folders.name AS folder_name
             FROM scenes
             LEFT JOIN folders ON folders.id = scenes.folder_id
             WHERE scenes.deleted_at IS NOT NULL
             ORDER BY scenes.deleted_at DESC`,
          )
          .all()
          .map(getSceneSummary);
        return jsonResponse(runtime, req, rows);
      }

      if (pathname === "/api/scenes" && req.method === "POST") {
        const body = requireJsonObject(
          await readJson(req, runtime.config.maxSceneBodyBytes),
        );
        const id = body.id
          ? validateId(body.id, "scene")
          : `scene_${Date.now().toString(36)}_${randomBytes(4).toString(
              "hex",
            )}`;
        const name = hasOwn(body, "name")
          ? validateName(body.name)
          : "未命名白板";
        const elements = hasOwn(body, "elements")
          ? validateElements(body.elements)
          : [];
        const appState = hasOwn(body, "appState")
          ? validateAppState(body.appState)
          : {};
        const { tags, favorite, folderId } = parseSceneMetadata(runtime, body);
        const fileIds = extractFileIds(elements);
        await assertReferencedFilesExist(runtime, fileIds);
        const now = Date.now();
        try {
          const transaction = runtime.db.transaction(() => {
            runtime.db.run(
              `INSERT INTO scenes
               (id, name, elements, app_state, created_at, updated_at, revision,
                tags_json, is_favorite, folder_id)
               VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
              [
                id,
                name,
                JSON.stringify(elements),
                JSON.stringify(appState),
                now,
                now,
                JSON.stringify(tags),
                favorite ? 1 : 0,
                folderId,
              ],
            );
            syncSceneFileReferences(runtime, id, fileIds);
          });
          transaction();
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
        return jsonResponse(
          runtime,
          req,
          getSceneSummary({
            id,
            name,
            created_at: now,
            updated_at: now,
            revision: 1,
            size: JSON.stringify(elements).length,
            element_count: elements.filter((el: any) => !el?.isDeleted).length,
            tags_json: JSON.stringify(tags),
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
        const folders = runtime.db
          .query(
            `SELECT folders.id, folders.name, folders.created_at, folders.updated_at,
                    COUNT(scenes.id) AS scene_count
             FROM folders
             LEFT JOIN scenes
               ON scenes.folder_id = folders.id
              AND scenes.deleted_at IS NULL
             GROUP BY folders.id
             ORDER BY folders.name COLLATE NOCASE ASC`,
          )
          .all();
        return jsonResponse(runtime, req, folders);
      }

      if (pathname === "/api/folders" && req.method === "POST") {
        const body = requireJsonObject(await readJson(req, 64 * 1024));
        const name = validateFolderName(body.name);
        const id = `folder_${Date.now().toString(36)}_${randomBytes(4).toString(
          "hex",
        )}`;
        const now = Date.now();
        try {
          runtime.db.run(
            "INSERT INTO folders (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            [id, name, now, now],
          );
        } catch (error: any) {
          if (
            String(error?.message || "")
              .toLowerCase()
              .includes("unique")
          ) {
            throw new HttpError(409, "FOLDER_EXISTS", "文件夹 ID 已存在");
          }
          throw error;
        }
        return jsonResponse(
          runtime,
          req,
          { id, name, created_at: now, updated_at: now, scene_count: 0 },
          201,
        );
      }

      if (pathname.startsWith("/api/folders/") && req.method === "PATCH") {
        const id = getPathId(pathname, "/api/folders/", "scene");
        const body = requireJsonObject(await readJson(req, 64 * 1024));
        const name = validateFolderName(body.name);
        const existing = runtime.db
          .query("SELECT id FROM folders WHERE id = ?")
          .get(id);
        if (!existing) {
          throw new HttpError(404, "FOLDER_NOT_FOUND", "文件夹不存在");
        }
        const now = Date.now();
        runtime.db.run(
          "UPDATE folders SET name = ?, updated_at = ? WHERE id = ?",
          [name, now, id],
        );
        const updated = getFolderSummary(runtime, id);
        if (!updated) {
          throw new HttpError(404, "FOLDER_NOT_FOUND", "文件夹不存在");
        }
        return jsonResponse(runtime, req, {
          success: true,
          ...updated,
        });
      }

      if (pathname.startsWith("/api/folders/") && req.method === "DELETE") {
        const id = getPathId(pathname, "/api/folders/", "scene");
        const existing = runtime.db
          .query("SELECT id FROM folders WHERE id = ?")
          .get(id);
        if (!existing) {
          return jsonResponse(runtime, req, {
            success: true,
            id,
            deleted: false,
          });
        }
        const transaction = runtime.db.transaction(() => {
          runtime.db.run(
            "UPDATE scenes SET folder_id = NULL WHERE folder_id = ?",
            [id],
          );
          runtime.db.run("DELETE FROM folders WHERE id = ?", [id]);
        });
        transaction();
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
        const existing = runtime.db
          .query("SELECT id, deleted_at FROM scenes WHERE id = ?")
          .get(id) as { id: string; deleted_at: number | null } | null;
        if (!existing) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在");
        }
        runtime.db.run("UPDATE scenes SET deleted_at = NULL WHERE id = ?", [
          id,
        ]);
        return jsonResponse(runtime, req, {
          success: true,
          id,
          restored: true,
        });
      }

      if (pathname.startsWith("/api/scenes/") && req.method === "GET") {
        const id = getPathId(pathname, "/api/scenes/", "scene");
        const row = runtime.db
          .query("SELECT * FROM scenes WHERE id = ? AND deleted_at IS NULL")
          .get(id);
        if (!row) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
        }
        return jsonResponse(runtime, req, parseStoredScene(row));
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
        const existing = stmts.getSceneById.get(id);
        if (!existing) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
        }
        const lastOpenedAt = Date.now();
        stmts.touchSceneLastOpened.run(lastOpenedAt, id);
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
        const existing = stmts.getSceneById.get(id);
        if (!existing) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
        }
        const contentType = req.headers.get("content-type")?.toLowerCase();
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
        const bytes = await readBody(req, runtime.config.maxFileBytes);
        if (!bytes.byteLength) {
          throw new HttpError(400, "EMPTY_THUMBNAIL", "画板缩略图不能为空");
        }
        const thumbnailId = `thumbnail_${createHash("sha256")
          .update(id)
          .digest("hex")}`;
        const thumbnailVersionHeader = req.headers.get("x-thumbnail-version");
        const thumbnailVersion = thumbnailVersionHeader
          ? Number(thumbnailVersionHeader)
          : undefined;
        if (
          thumbnailVersion !== undefined &&
          (!Number.isSafeInteger(thumbnailVersion) || thumbnailVersion <= 0)
        ) {
          throw new HttpError(
            400,
            "INVALID_THUMBNAIL_VERSION",
            "画板缩略图版本无效",
          );
        }
        return withThumbnailWriteLock(thumbnailId, async () => {
          const currentThumbnail = stmts.getFileUpdatedAt.get(thumbnailId) as
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
          await upsertFile(
            runtime,
            thumbnailId,
            contentType,
            bytes,
            undefined,
            thumbnailVersion,
          );
          runtime.db.run(
            "UPDATE scenes SET thumbnail_file_id = ? WHERE id = ?",
            [thumbnailId, id],
          );
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
        const existing = runtime.db
          .query(
            "SELECT id, thumbnail_file_id FROM scenes WHERE id = ? AND deleted_at IS NULL",
          )
          .get(id) as { id: string; thumbnail_file_id: string | null } | null;
        if (!existing) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
        }
        const thumbnailId = `thumbnail_${createHash("sha256")
          .update(id)
          .digest("hex")}`;
        const thumbnailVersionHeader = req.headers.get("x-thumbnail-version");
        const thumbnailVersion = thumbnailVersionHeader
          ? Number(thumbnailVersionHeader)
          : undefined;
        if (
          thumbnailVersion !== undefined &&
          (!Number.isSafeInteger(thumbnailVersion) || thumbnailVersion <= 0)
        ) {
          throw new HttpError(
            400,
            "INVALID_THUMBNAIL_VERSION",
            "画板缩略图版本无效",
          );
        }
        return withThumbnailWriteLock(thumbnailId, async () => {
          const currentThumbnail = stmts.getFileUpdatedAt.get(thumbnailId) as
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
          runtime.db.run(
            "UPDATE scenes SET thumbnail_file_id = NULL WHERE id = ?",
            [id],
          );
          if (currentThumbnail && thumbnailVersion !== undefined) {
            runtime.db.run("UPDATE files SET updated_at = ? WHERE id = ?", [
              thumbnailVersion,
              thumbnailId,
            ]);
          }
          return jsonResponse(runtime, req, {
            success: true,
            id,
            thumbnail_file_id: null,
          });
        });
      }

      if (pathname.startsWith("/api/scenes/") && req.method === "PATCH") {
        const id = getPathId(pathname, "/api/scenes/", "scene");
        const body = requireJsonObject(await readJson(req, 64 * 1024));
        if (
          !["name", "tags", "favorite", "folder_id"].some((key) =>
            hasOwn(body, key),
          )
        ) {
          throw new HttpError(400, "INVALID_METADATA", "没有可更新的画板信息");
        }
        const baseRevision = requireRevision(body.baseRevision);
        const existing = runtime.db
          .query("SELECT * FROM scenes WHERE id = ? AND deleted_at IS NULL")
          .get(id) as { revision: number } | null;
        if (!existing) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
        }
        if (baseRevision !== undefined && baseRevision !== existing.revision) {
          throw new HttpError(
            409,
            "REVISION_CONFLICT",
            "云端画板已被其他操作更新",
          );
        }
        const { name, tags, favorite, folderId } = parseSceneMetadata(
          runtime,
          body,
          existing,
        );
        const now = Date.now();
        const revision = existing.revision + 1;
        runtime.db.run(
          `UPDATE scenes
           SET name = ?, tags_json = ?, is_favorite = ?, folder_id = ?,
               updated_at = ?, revision = ?
           WHERE id = ?`,
          [
            name,
            JSON.stringify(tags),
            favorite ? 1 : 0,
            folderId,
            now,
            revision,
            id,
          ],
        );
        const updated = runtime.db
          .query(
            `SELECT scenes.id, scenes.name, scenes.created_at, scenes.updated_at,
                    scenes.revision, length(scenes.elements) AS size,
                    CASE WHEN json_valid(scenes.elements) = 1
                         THEN (SELECT COUNT(*) FROM json_each(scenes.elements) WHERE COALESCE(json_extract(value, '$.isDeleted'), 0) NOT IN (1, 1=1, 'true'))
                         ELSE 0 END AS element_count,
                    scenes.tags_json, scenes.is_favorite, scenes.folder_id,
                    scenes.last_opened_at, scenes.thumbnail_file_id, scenes.deleted_at,
                    folders.name AS folder_name
             FROM scenes
             LEFT JOIN folders ON folders.id = scenes.folder_id
             WHERE scenes.id = ?`,
          )
          .get(id);
        return jsonResponse(runtime, req, getSceneSummary(updated));
      }

      if (pathname.startsWith("/api/scenes/") && req.method === "PUT") {
        const id = getPathId(pathname, "/api/scenes/", "scene");
        const body = requireJsonObject(
          await readJson(req, runtime.config.maxSceneBodyBytes),
        );
        const existing = runtime.db
          .query("SELECT * FROM scenes WHERE id = ? AND deleted_at IS NULL")
          .get(id) as any;
        if (!existing) {
          throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
        }
        const baseRevision = requireRevision(body.baseRevision);
        const currentRevision = Number(existing.revision) || 1;
        if (baseRevision !== undefined && baseRevision !== currentRevision) {
          throw new HttpError(
            409,
            "REVISION_CONFLICT",
            "云端画板已被其他设备更新",
          );
        }
        const { name, tags, favorite, folderId } = parseSceneMetadata(
          runtime,
          body,
          existing,
        );
        const elements = hasOwn(body, "elements")
          ? validateElements(body.elements)
          : JSON.parse(existing.elements || "[]");
        const appState = hasOwn(body, "appState")
          ? validateAppState(body.appState)
          : JSON.parse(existing.app_state || "{}");
        const fileIds = extractFileIds(elements);
        await assertReferencedFilesExist(runtime, fileIds);
        const now = Date.now();
        const revision = currentRevision + 1;
        const transaction = runtime.db.transaction(() => {
          runtime.db.run(
            `UPDATE scenes
             SET name = ?, elements = ?, app_state = ?, tags_json = ?,
                 is_favorite = ?, folder_id = ?, updated_at = ?, revision = ?
             WHERE id = ?`,
            [
              name,
              JSON.stringify(elements),
              JSON.stringify(appState),
              JSON.stringify(tags),
              favorite ? 1 : 0,
              folderId,
              now,
              revision,
              id,
            ],
          );
          syncSceneFileReferences(runtime, id, fileIds);
        });
        transaction();
        return jsonResponse(runtime, req, {
          success: true,
          id,
          updated_at: now,
          revision,
        });
      }

      if (pathname === "/api/scenes/trash" && req.method === "DELETE") {
        const result = runtime.db.run(
          "DELETE FROM scenes WHERE deleted_at IS NOT NULL",
        );
        return jsonResponse(runtime, req, {
          success: true,
          deletedCount: result.changes,
        });
      }

      if (pathname.startsWith("/api/scenes/") && req.method === "DELETE") {
        const id = getPathId(pathname, "/api/scenes/", "scene");
        const existing = runtime.db
          .query("SELECT id, deleted_at FROM scenes WHERE id = ?")
          .get(id) as { id: string; deleted_at: number | null } | null;
        if (!existing) {
          return jsonResponse(runtime, req, {
            success: true,
            id,
            deleted: false,
          });
        }
        const isPermanent = url.searchParams.get("permanent") === "true";
        if (isPermanent) {
          const transaction = runtime.db.transaction(() => {
            runtime.db.run("DELETE FROM scene_files WHERE scene_id = ?", [id]);
            runtime.db.run("DELETE FROM scenes WHERE id = ?", [id]);
          });
          transaction();
          return jsonResponse(runtime, req, {
            success: true,
            id,
            deleted: true,
            permanent: true,
          });
        }
        const now = Date.now();
        runtime.db.run("UPDATE scenes SET deleted_at = ? WHERE id = ?", [
          now,
          id,
        ]);
        return jsonResponse(runtime, req, {
          success: true,
          id,
          deleted: true,
          permanent: false,
          deleted_at: now,
        });
      }

      if (pathname === "/api/files" && req.method === "POST") {
        const body = requireJsonObject(
          await readJson(req, runtime.config.maxFilesBodyBytes),
        );
        const uploaded = [];
        for (const [fileId, value] of parseFileUploadEntries(body)) {
          const id = validateId(fileId, "file");
          const data = requireJsonObject(value);
          const mimeType = validateMimeType(data.mimeType || "image/png");
          const bytes = decodeDataUrl(data.dataURL, mimeType);
          uploaded.push(
            await upsertFile(
              runtime,
              id,
              mimeType,
              bytes,
              Number(data.created),
            ),
          );
        }
        return jsonResponse(
          runtime,
          req,
          { success: true, files: uploaded },
          201,
        );
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
        const bytes = await readBody(req, runtime.config.maxFileBytes);
        if (!bytes.byteLength) {
          throw new HttpError(400, "EMPTY_FILE", "文件内容不能为空");
        }
        const file = await upsertFile(runtime, id, mimeType, bytes);
        return jsonResponse(runtime, req, { success: true, file }, 201);
      }

      if (pathname.startsWith("/api/files/") && req.method === "GET") {
        const id = getPathId(pathname, "/api/files/", "file");
        const row = stmts.getFileById.get(id) as any;
        if (!row?.storage_path) {
          throw new HttpError(404, "FILE_NOT_FOUND", "文件不存在");
        }
        const filePath = getFilePath(runtime, id);
        if (!(await fileExists(filePath))) {
          throw new HttpError(404, "FILE_NOT_FOUND", "文件不存在");
        }

        const etag = row.sha256 ? `"${row.sha256}"` : undefined;
        const ifNoneMatch = req.headers.get("if-none-match");

        if (String(row.mime_type).toLowerCase() === "image/svg+xml") {
          return response(runtime, req, Bun.file(filePath), {
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": `attachment; filename="${id}"`,
              "Content-Length": String(row.byte_size),
              "X-File-Created-At": String(row.created_at),
              "Cache-Control": "private, no-store",
            },
          });
        }

        const cacheControl = id.startsWith("thumbnail_")
          ? "private, no-cache"
          : "private, max-age=31536000, immutable";

        if (etag && ifNoneMatch) {
          const clientEtags = ifNoneMatch
            .split(",")
            .map((item) => item.trim());
          if (clientEtags.includes(etag) || clientEtags.includes("*")) {
            const notModifiedHeaders: Record<string, string> = {
              ETag: etag,
              "Cache-Control": cacheControl,
            };
            return response(runtime, req, null, {
              status: 304,
              headers: notModifiedHeaders,
            });
          }
        }

        const accept = req.headers.get("accept") || "";
        const wantsBinary =
          accept.includes("application/octet-stream") ||
          accept.includes("image/");
        if (!wantsBinary) {
          const bytes = await Bun.file(filePath).arrayBuffer();
          const jsonHeaders: Record<string, string> = {};
          if (etag) {
            jsonHeaders.ETag = etag;
          }
          return jsonResponse(
            runtime,
            req,
            {
              id,
              dataURL: `data:${row.mime_type};base64,${Buffer.from(
                bytes,
              ).toString("base64")}`,
              mimeType: row.mime_type,
              created_at: row.created_at,
            },
            200,
            jsonHeaders,
          );
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

        return response(runtime, req, Bun.file(filePath), {
          headers: responseHeaders,
        });
      }

      if (pathname === "/__dev_reload" && req.method === "GET") {
        return handleDevReloadRequest(req);
      }

      if (pathname.startsWith("/api/")) {
        throw new HttpError(404, "NOT_FOUND", "接口不存在");
      }

      const staticDir = getStaticDir(runtime);
      const staticPath = buildStaticPath(staticDir, pathname);
      if (!staticPath) {
        throw new HttpError(400, "INVALID_PATH", "无效的资源路径");
      }
      if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
        return response(runtime, req, Bun.file(staticPath), {
          headers: { "Cache-Control": getStaticCacheControl(pathname) },
        });
      }
      const acceptsHtml = (req.headers.get("accept") || "")
        .toLowerCase()
        .includes("text/html");
      if (acceptsHtml) {
        const indexPath = path.join(staticDir, "index.html");
        if (fs.existsSync(indexPath)) {
          return response(runtime, req, Bun.file(indexPath), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-cache",
            },
          });
        }
      }
      if (pathname !== "/") {
        throw new HttpError(404, "STATIC_NOT_FOUND", "资源不存在");
      }
      return response(
        runtime,
        req,
        "Excalidraw Bun Server is running. Please build the frontend first (bun run build).",
        { headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    } catch (error) {
      return errorResponse(runtime, req, error);
    }
  };

  return handler;
};
