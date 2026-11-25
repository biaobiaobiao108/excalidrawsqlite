import { HttpError } from "./errors";
import {
  fileExists,
  getFilePath,
  stageRequestBodyToFile,
  upsertStagedFile,
  withStorageMutationLock,
} from "./files";
import { jsonResponse, response } from "./http";
import { storedSceneRevision } from "./scenes";
import { getPathId, validateMimeType } from "./validation";
import { publishSceneChanged, type RouteContext } from "./routes-shared";
import type { SceneRealtimeEvent, ServerRuntime } from "./types";

const openStableFileResponseStream = async (filePath: string) => {
  const reader = Bun.file(filePath).stream().getReader();
  let firstChunk: Awaited<ReturnType<typeof reader.read>>;
  try {
    // Opening the stream and reading its first chunk pins the current file
    // before the storage mutation lock is released. Atomic replacement can
    // then proceed without changing the bytes served by this response.
    firstChunk = await reader.read();
  } catch (error) {
    reader.releaseLock();
    throw error;
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (firstChunk.done) {
        reader.releaseLock();
        controller.close();
        return;
      }
      controller.enqueue(firstChunk.value);
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          reader.releaseLock();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });
};

const updateScenesAfterFileReplacement = (
  runtime: ServerRuntime,
  fileId: string,
): SceneRealtimeEvent[] => {
  const now = Date.now();
  const affectedScenes = runtime.db
    .query(
      `SELECT scenes.id, scenes.revision,
              EXISTS (
                SELECT 1 FROM scene_files
                WHERE scene_files.scene_id = scenes.id AND scene_files.file_id = ?
              ) AS references_file,
              scenes.thumbnail_file_id = ? AS is_thumbnail
       FROM scenes
       WHERE scenes.id IN (
         SELECT scene_id FROM scene_files WHERE file_id = ?
         UNION SELECT id FROM scenes WHERE thumbnail_file_id = ?
       )`,
    )
    .all(fileId, fileId, fileId, fileId) as Array<{
    id: string;
    revision: number;
    references_file: number;
    is_thumbnail: number;
  }>;
  const events: SceneRealtimeEvent[] = [];

  for (const scene of affectedScenes) {
    const revision = storedSceneRevision(scene.revision);
    if (scene.references_file) {
      const nextRevision = revision + 1;
      const result = runtime.db.run(
        `UPDATE scenes
         SET revision = ?, updated_at = ?, thumbnail_file_id = NULL
         WHERE id = ? AND revision = ?`,
        [nextRevision, now, scene.id, revision],
      );
      if (result.changes !== 1) {
        throw new HttpError(
          409,
          "REVISION_CONFLICT",
          "画板版本冲突或状态已变更",
        );
      }
      events.push({
        type: "scene_changed",
        sceneId: scene.id,
        revision: nextRevision,
        updatedAt: now,
        changeKind: "content",
      });
      continue;
    }

    if (scene.is_thumbnail) {
      events.push({
        type: "scene_changed",
        sceneId: scene.id,
        revision,
        updatedAt: now,
        changeKind: "thumbnail",
      });
    }
  }
  return events;
};

export const handleFileRoute = async ({
  runtime,
  req,
  pathname,
  stmts,
}: RouteContext): Promise<Response | null> => {
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
    const sceneEvents: SceneRealtimeEvent[] = [];
    const file = await upsertStagedFile(
      runtime,
      id,
      mimeType,
      prepared,
      undefined,
      undefined,
      undefined,
      () => sceneEvents.push(...updateScenesAfterFileReplacement(runtime, id)),
    );
    for (const event of sceneEvents) {
      publishSceneChanged(runtime, event);
    }
    return jsonResponse(runtime, req, { success: true, file }, 201, {
      ETag: `"${file.sha256}"`,
    });
  }

  if (pathname.startsWith("/api/files/") && req.method === "GET") {
    const id = getPathId(pathname, "/api/files/", "file");
    return await withStorageMutationLock(runtime, async () => {
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
      // File IDs can be overwritten by PUT, so clients must revalidate even
      // when the response carries a content hash ETag.
      const cacheControl = "private, no-cache";

      if (etag && ifNoneMatch) {
        const clientEtags = ifNoneMatch.split(",").map((item) => item.trim());
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

      const body = await openStableFileResponseStream(filePath);
      if (String(row.mime_type).toLowerCase() === "image/svg+xml") {
        return response(runtime, req, body, {
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

      return response(runtime, req, body, {
        headers: responseHeaders,
      });
    });
  }

  return null;
};
