import { listScenePage } from "./scene-list";
import { HttpError } from "./errors";
import { jsonResponse, readJson } from "./http";
import { storedSceneRevision } from "./scenes";
import { requireJsonObject, requireRevision, validateId } from "./validation";
import { getWorkspaceStats } from "./workspace";
import {
  publishSceneChanged,
  publishWorkspaceChanged,
  type RouteContext,
} from "./routes-shared";

const MAX_SCENE_BATCH_SIZE = 500;

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
    const changedEntries: Array<{
      entry: (typeof entries)[number];
      updatedAt: number;
    }> = [];
    const transaction = runtime.db.transaction(() => {
      for (const entry of entries) {
        const existing = stmts.getSceneStateById.get(entry.id) as {
          id: string;
          deleted_at: number | null;
          revision: number;
          updated_at: number;
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
          changedEntries.push({
            entry,
            updatedAt: Number(existing.updated_at),
          });
        }
      }

      for (const { entry } of changedEntries) {
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
          const result = stmts.restoreScene.run(entry.id, entry.revision);
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
    for (const { entry, updatedAt } of changedEntries) {
      publishSceneChanged(runtime, {
        type: "scene_changed",
        sceneId: entry.id,
        revision: entry.revision + (isPermanent ? 0 : 1),
        updatedAt,
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
