import { randomHex } from "./crypto";
import { HttpError } from "./errors";
import { jsonResponse, readJson } from "./http";
import { storedSceneRevision } from "./scenes";
import {
  getPathId,
  hasOwn,
  requireJsonObject,
  validateFolderColor,
  validateFolderIcon,
  validateFolderName,
} from "./validation";
import {
  publishSceneChanged,
  publishWorkspaceChanged,
  type RouteContext,
} from "./routes-shared";
import type { ServerRuntime } from "./types";

const getFolderSummary = (runtime: ServerRuntime, id: string) =>
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

export const handleFolderRoute = async ({
  runtime,
  req,
  pathname,
  stmts,
}: RouteContext): Promise<Response | null> => {
  if (
    pathname.startsWith("/api/folders") &&
    pathname === "/api/folders" &&
    req.method === "GET"
  ) {
    const folders = stmts.listFolders.all();
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
      body.color === undefined ? "#315f4c" : validateFolderColor(body.color);
    const id = `folder_${Date.now().toString(36)}_${randomHex(4)}`;
    const now = Date.now();
    try {
      runtime.db
        .transaction(() => {
          if (stmts.getFolderNameConflict.get(name, id)) {
            throw new HttpError(
              409,
              "FOLDER_NAME_EXISTS",
              "同名文件夹已存在，请使用已有文件夹或更换名称",
            );
          }
          runtime.db.run(
            "INSERT INTO folders (id, name, icon, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            [id, name, icon, color, now, now],
          );
        })
        .immediate();
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
    const id = getPathId(pathname, "/api/folders/", "folder");
    const body = requireJsonObject(
      await readJson(req, 64 * 1024, runtime.bodyMemoryBudget),
    );
    const name = validateFolderName(body.name);
    const existing = stmts.getFolderById.get(id) as {
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
    if (
      name === existing.name &&
      icon === existing.icon &&
      color === existing.color
    ) {
      return jsonResponse(runtime, req, {
        success: true,
        ...(getFolderSummary(runtime, id) as Record<string, unknown>),
        noop: true,
      });
    }
    const now = Date.now();
    runtime.db
      .transaction(() => {
        if (stmts.getFolderNameConflict.get(name, id)) {
          throw new HttpError(
            409,
            "FOLDER_NAME_EXISTS",
            "同名文件夹已存在，请更换名称",
          );
        }
        runtime.db.run(
          "UPDATE folders SET name = ?, icon = ?, color = ?, updated_at = ? WHERE id = ?",
          [name, icon, color, now, id],
        );
      })
      .immediate();
    const updated = getFolderSummary(runtime, id);
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
    const id = getPathId(pathname, "/api/folders/", "folder");
    const existing = stmts.getFolderById.get(id);
    if (!existing) {
      return jsonResponse(runtime, req, {
        success: true,
        id,
        deleted: false,
      });
    }
    const affectedScenes = runtime.db
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
    const transaction = runtime.db.transaction(() => {
      const updateScene = runtime.db.query(
        `UPDATE scenes
         SET folder_id = NULL, updated_at = ?, revision = ?
         WHERE id = ? AND folder_id = ?`,
      );
      for (const scene of affectedScenes) {
        updateScene.run(
          now,
          storedSceneRevision(scene.revision) + 1,
          scene.id,
          id,
        );
      }
      runtime.db.run("DELETE FROM folders WHERE id = ?", [id]);
    });
    transaction.immediate();
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

  return null;
};
