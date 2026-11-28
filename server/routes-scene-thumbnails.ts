import fs from "node:fs";

import { sha256Hex } from "./crypto";
import { HttpError } from "./errors";
import {
  stageRequestBodyToFile,
  upsertStagedFile,
  withThumbnailWriteLock,
} from "./files";
import { jsonResponse } from "./http";
import { storedSceneRevision } from "./scenes";
import { getPathId, requireRevision } from "./validation";
import { publishSceneChanged, type RouteContext } from "./routes-shared";

const MAX_THUMBNAIL_VERSION_FUTURE_SKEW_MS = 5 * 60 * 1000;

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
    throw new HttpError(400, "INVALID_THUMBNAIL_VERSION", "画板缩略图版本无效");
  }
  return version;
};

export const handleSceneThumbnailRoute = async ({
  runtime,
  req,
  url,
  pathname,
  stmts,
}: RouteContext): Promise<Response | null> => {
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
    const sceneRevision = storedSceneRevision(
      (stmts.getSceneRevision.get(id) as { revision: number } | null)?.revision,
    );
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
    const thumbnailId = `thumbnail_${sha256Hex(id)}`;
    const thumbnailVersion = parseThumbnailVersion(req);
    const revisionParam = url.searchParams.get("revision");
    const expectedRevision =
      revisionParam === null
        ? sceneRevision
        : requireRevision(Number(revisionParam))!;
    const assertThumbnailRevision = () => {
      const current = stmts.getSceneVersionById.get(id) as {
        revision: number;
        thumbnail_file_id: string | null;
      } | null;
      if (!current || current.revision !== expectedRevision) {
        throw new HttpError(
          409,
          "REVISION_CONFLICT",
          "画板内容已更新，请重新生成预览",
        );
      }
      return current;
    };
    return await withThumbnailWriteLock(thumbnailId, async () => {
      const current = assertThumbnailRevision();
      if (revisionParam !== null && thumbnailVersion === undefined) {
        // Another tab may have repaired the same board while this upload waited.
        if (current.thumbnail_file_id) {
          return jsonResponse(runtime, req, {
            success: true,
            id,
            thumbnail_file_id: current.thumbnail_file_id,
          });
        }
      }
      const currentThumbnail = stmts.getFileUpdatedAt.get(thumbnailId) as {
        updated_at: number;
      } | null;
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
      try {
        assertThumbnailRevision();
        await upsertStagedFile(
          runtime,
          thumbnailId,
          contentType,
          prepared,
          undefined,
          thumbnailVersion,
          assertThumbnailRevision,
          undefined,
          false,
          () => {
            const linked = runtime.db.run(
              `UPDATE scenes SET thumbnail_file_id = ? WHERE id = ? AND deleted_at IS NULL
               AND revision = ?`,
              [thumbnailId, id, expectedRevision],
            );
            if (linked.changes !== 1) {
              throw new HttpError(
                409,
                "REVISION_CONFLICT",
                "画板内容已更新，请重新生成预览",
              );
            }
          },
        );
      } finally {
        if (prepared.tempPath) {
          await fs.promises.rm(prepared.tempPath, { force: true });
        }
      }
      publishSceneChanged(runtime, {
        type: "scene_changed",
        sceneId: id,
        revision: expectedRevision,
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
    const existing = stmts.getSceneThumbnailById.get(id) as {
      id: string;
      thumbnail_file_id: string | null;
    } | null;
    if (!existing) {
      throw new HttpError(404, "SCENE_NOT_FOUND", "画板不存在或已删除");
    }
    const sceneRevision = storedSceneRevision(
      (stmts.getSceneRevision.get(id) as { revision: number } | null)?.revision,
    );
    const thumbnailId = `thumbnail_${sha256Hex(id)}`;
    const thumbnailVersion = parseThumbnailVersion(req);
    const revisionParam = url.searchParams.get("revision");
    const expectedRevision =
      revisionParam === null
        ? sceneRevision
        : requireRevision(Number(revisionParam))!;
    return await withThumbnailWriteLock(thumbnailId, async () => {
      const current = stmts.getSceneVersionById.get(id) as {
        revision: number;
      } | null;
      if (!current || current.revision !== expectedRevision) {
        throw new HttpError(
          409,
          "REVISION_CONFLICT",
          "画板内容已更新，请重新生成预览",
        );
      }
      const currentThumbnail = stmts.getFileUpdatedAt.get(thumbnailId) as {
        updated_at: number;
      } | null;
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
      runtime.db
        .transaction(() => {
          const unlinked = runtime.db.run(
            "UPDATE scenes SET thumbnail_file_id = NULL WHERE id = ? AND deleted_at IS NULL AND revision = ?",
            [id, expectedRevision],
          );
          if (unlinked.changes !== 1) {
            throw new HttpError(
              409,
              "REVISION_CONFLICT",
              "画板内容已更新，请重新生成预览",
            );
          }
          if (currentThumbnail && thumbnailVersion !== undefined) {
            runtime.db.run("UPDATE files SET updated_at = ? WHERE id = ?", [
              thumbnailVersion,
              thumbnailId,
            ]);
          }
        })
        .immediate();
      publishSceneChanged(runtime, {
        type: "scene_changed",
        sceneId: id,
        revision: expectedRevision,
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

  return null;
};
