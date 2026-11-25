import { randomHex, sha256Hex } from "./crypto";
import { HttpError } from "./errors";
import {
  findCreateReplay,
  isMcpCreateSession,
  parseCreateRequest,
  recordCreateRequest,
} from "./create-idempotency";
import { getSessionToken } from "./auth";
import {
  assertReferencedFilesExist,
  extractFileIds,
  syncSceneFileReferences,
  withStorageMutationLock,
} from "./files";
import { jsonResponse, readJson, response } from "./http";
import {
  getSceneSummary,
  parseSceneMetadata,
  parseStoredAppState,
  parseStoredElements,
  parseStoredScene,
  sanitizeSceneElements,
  storedSceneRevision,
} from "./scenes";
import {
  getPathId,
  hasOwn,
  parseStoredTagsStrict,
  requireJsonObject,
  requireRevision,
  validateAppState,
  validateElements,
  validateFavorite,
  validateFolderId,
  validateId,
  validateName,
  validateTags,
} from "./validation";
import {
  assertSceneFolderExists,
  publishSceneChanged,
  type RouteContext,
} from "./routes-shared";

export const handleSceneRoute = async ({
  runtime,
  req,
  url,
  pathname,
  stmts,
}: RouteContext): Promise<Response | null> => {
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
    const name = hasOwn(body, "name") ? validateName(body.name) : "未命名白板";
    const rawElements = hasOwn(body, "elements")
      ? validateElements(body.elements)
      : [];
    const elements = sanitizeSceneElements(rawElements);
    const appState = hasOwn(body, "appState")
      ? validateAppState(body.appState)
      : {};
    const tags = hasOwn(body, "tags") ? validateTags(body.tags) : [];
    const favorite = hasOwn(body, "favorite")
      ? validateFavorite(body.favorite)
      : false;
    const folderId = hasOwn(body, "folder_id")
      ? validateFolderId(body.folder_id)
      : null;
    const fileIds = extractFileIds(elements);
    const elementsJson = JSON.stringify(elements);
    const appStateJson = JSON.stringify(appState);
    const tagsJson = JSON.stringify(tags);
    const contentBytes = Buffer.byteLength(elementsJson, "utf8");
    const now = Date.now();
    if (
      hasOwn(body, "idempotencyPayload") &&
      (!hasOwn(body, "idempotencyKey") ||
        !isMcpCreateSession(runtime, getSessionToken(runtime, req)))
    ) {
      throw new HttpError(
        400,
        "INVALID_IDEMPOTENCY_PAYLOAD",
        "idempotencyPayload 仅供内部 MCP 创建请求使用",
      );
    }
    const createRequest = parseCreateRequest(
      body,
      hasOwn(body, "idempotencyPayload")
        ? body.idempotencyPayload
        : {
            id: hasOwn(body, "id") ? id : null,
            name,
            elements,
            appState,
            tags,
            favorite,
            folderId,
          },
    );
    const replay = {
      summary: null as ReturnType<typeof getSceneSummary> | null,
    };
    await withStorageMutationLock(
      runtime,
      async () => {
        // Check before attachment I/O. Retries return the current board even
        // if its original attachments were replaced after creation.
        if (createRequest) {
          runtime.db
            .transaction(() => {
              const replayId = findCreateReplay(runtime.db, createRequest, now);
              if (!replayId) return;
              const row = stmts.getSceneSummaryById.get(replayId) as any;
              if (!row || row.deleted_at != null)
                throw new HttpError(
                  409,
                  "IDEMPOTENT_BOARD_DELETED",
                  "该幂等创建请求的画板已删除；如需新建请使用新 key",
                );
              replay.summary = getSceneSummary(row);
            })
            .immediate();
          if (replay.summary) return;
        }
        await assertReferencedFilesExist(runtime, fileIds);
        try {
          const transaction = runtime.db.transaction(() => {
            if (createRequest) {
              // Another process may have committed while file I/O yielded.
              const replayId = findCreateReplay(runtime.db, createRequest, now);
              if (replayId) {
                const row = stmts.getSceneSummaryById.get(replayId) as any;
                if (!row || row.deleted_at != null)
                  throw new HttpError(
                    409,
                    "IDEMPOTENT_BOARD_DELETED",
                    "该幂等创建请求的画板已删除；如需新建请使用新 key",
                  );
                replay.summary = getSceneSummary(row);
                return;
              }
            }
            // Attachment checks and the storage queue can yield after metadata
            // validation. Recheck inside the synchronous commit so deletion
            // cannot leave a board referencing a folder that no longer exists.
            assertSceneFolderExists(stmts, folderId);
            runtime.db.run(
              `INSERT INTO scenes
             (id, name, elements, app_state, created_at, updated_at, revision,
              tags_json, is_favorite, folder_id, element_count, content_bytes)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
              [
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
              ],
            );
            syncSceneFileReferences(runtime, id, fileIds);
            if (createRequest)
              recordCreateRequest(runtime.db, createRequest, id, now);
          });
          transaction.immediate();
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
      },
      req.signal,
    );
    if (replay.summary)
      return jsonResponse(
        runtime,
        req,
        { ...replay.summary, idempotentReplay: true },
        200,
      );
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
    pathname.startsWith("/api/scenes/") &&
    pathname.endsWith("/restore") &&
    req.method === "POST"
  ) {
    const id = getPathId(
      pathname.slice(0, -"/restore".length),
      "/api/scenes/",
      "scene",
    );
    const existing = stmts.getSceneStateById.get(id) as {
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
    const result = stmts.restoreScene.run(updatedAt, id, revision - 1);
    if (result.changes !== 1) {
      throw new HttpError(409, "REVISION_CONFLICT", "画板版本冲突或状态已变更");
    }
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
    const row = stmts.getSceneSummaryById.get(id);
    if (!row) {
      throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在");
    }
    return jsonResponse(runtime, req, getSceneSummary(row));
  }

  if (pathname.startsWith("/api/scenes/") && req.method === "GET") {
    const id = getPathId(pathname, "/api/scenes/", "scene");
    const versionRow = stmts.getSceneVersionById.get(id) as {
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
    // `POST /open` bumps last_opened_at on every visit but does not change
    // the document. Keeping it out of the validator lets the browser reuse
    // the cached body instead of re-downloading the whole scene each time.
    const etag = `"scene-${sha256Hex(
      JSON.stringify([
        id,
        sceneRevision,
        sceneUpdatedAt,
        versionRow.thumbnail_file_id,
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
    const row = stmts.getSceneRawById.get(id);
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
    const existing = stmts.getSceneById.get(id);
    if (!existing) {
      throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
    }
    const lastOpenedAt = Date.now();
    stmts.touchSceneLastOpened.run(lastOpenedAt, id);
    return jsonResponse(runtime, req, { success: true, id, lastOpenedAt });
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
    const existing = stmts.getSceneMetadataById.get(id) as {
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
      throw new HttpError(409, "REVISION_CONFLICT", "云端画板已被其他操作更新");
    }
    const { name, tags, favorite, folderId } = parseSceneMetadata(
      runtime,
      body,
      existing,
    );
    let currentTags: string[] | null;
    try {
      currentTags = parseStoredTagsStrict(existing.tags_json);
    } catch (error) {
      if (!hasOwn(body, "tags")) {
        throw error;
      }
      // An explicit tags replacement can repair invalid persisted data.
      currentTags = null;
    }
    const tagsUnchanged =
      currentTags !== null &&
      tags.length === currentTags.length &&
      tags.every((tag) => currentTags.includes(tag));
    if (
      name === existing.name &&
      favorite === Boolean(existing.is_favorite) &&
      folderId === existing.folder_id &&
      tagsUnchanged
    ) {
      return jsonResponse(runtime, req, {
        ...getSceneSummary(stmts.getSceneSummaryById.get(id)),
        noop: true,
      });
    }
    const now = Date.now();
    const revision = currentRevision + 1;
    const transaction = runtime.db.transaction(() => {
      assertSceneFolderExists(stmts, folderId);
      const result = runtime.db.run(
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
    });
    transaction.immediate();
    const updated = stmts.getSceneSummaryById.get(id);
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
    const existing = stmts.getSceneRawById.get(id) as any;
    if (!existing) {
      throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
    }
    const baseRevision = requireRevision(body.baseRevision);
    const currentRevision = storedSceneRevision(existing.revision);
    if (baseRevision !== undefined && baseRevision !== currentRevision) {
      throw new HttpError(409, "REVISION_CONFLICT", "云端画板已被其他设备更新");
    }
    const { name, tags, favorite, folderId } = parseSceneMetadata(
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
    const contentBytes = Buffer.byteLength(elementsJson, "utf8");
    const contentChanged =
      existing.elements !== elementsJson || existing.app_state !== appStateJson;
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
    const transaction = runtime.db.transaction(() => {
      assertSceneFolderExists(stmts, folderId);
      const result = runtime.db.run(
        `UPDATE scenes
         SET name = ?, elements = ?, app_state = ?, tags_json = ?,
             is_favorite = ?, folder_id = ?, updated_at = ?, revision = ?,
             element_count = ?, content_bytes = ?,
             thumbnail_file_id = CASE WHEN ? THEN NULL ELSE thumbnail_file_id END
         WHERE id = ? AND deleted_at IS NULL AND revision = ?`,
        [
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
          contentChanged ? 1 : 0,
          id,
          currentRevision,
        ],
      );
      if (result.changes !== 1) {
        throw new HttpError(
          409,
          "REVISION_CONFLICT",
          "云端画板已被其他设备更新",
        );
      }
      syncSceneFileReferences(runtime, id, fileIds);
    });
    await withStorageMutationLock(
      runtime,
      async () => {
        await assertReferencedFilesExist(runtime, fileIds);
        transaction.immediate();
      },
      req.signal,
    );
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

  if (pathname.startsWith("/api/scenes/") && req.method === "DELETE") {
    const id = getPathId(pathname, "/api/scenes/", "scene");
    const isPermanent = url.searchParams.get("permanent") === "true";
    const revisionParam = url.searchParams.get("revision");
    const expectedRevision =
      revisionParam === null
        ? undefined
        : requireRevision(Number(revisionParam));
    if (isPermanent && expectedRevision === undefined) {
      throw new HttpError(
        400,
        "INVALID_REVISION",
        "彻底删除画板必须提供有效的 revision",
      );
    }
    const existing = stmts.getSceneStateById.get(id) as {
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
    if (
      expectedRevision !== undefined &&
      storedSceneRevision(existing.revision) !== expectedRevision
    ) {
      throw new HttpError(
        409,
        "SCENE_SELECTION_STALE",
        "选中的画板已发生变化，请刷新列表后重新选择",
      );
    }
    if (isPermanent) {
      const transaction = runtime.db.transaction(() => {
        const current = stmts.getSceneStateById.get(id) as {
          revision: number;
        } | null;
        if (
          !current ||
          storedSceneRevision(current.revision) !== expectedRevision
        ) {
          throw new HttpError(
            409,
            "SCENE_SELECTION_STALE",
            "选中的画板已发生变化，请刷新列表后重新选择",
          );
        }
        runtime.db.run("DELETE FROM scene_files WHERE scene_id = ?", [id]);
        const deleted = runtime.db.run(
          "DELETE FROM scenes WHERE id = ? AND revision = ?",
          [id, expectedRevision],
        );
        if (deleted.changes !== 1) {
          throw new HttpError(
            409,
            "SCENE_SELECTION_STALE",
            "选中的画板已发生变化，请刷新列表后重新选择",
          );
        }
      });
      transaction.immediate();
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
    const result = stmts.softDeleteScene.run(now, now, id, revision - 1);
    if (result.changes !== 1) {
      throw new HttpError(409, "REVISION_CONFLICT", "画板版本冲突或状态已变更");
    }
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

  return null;
};
