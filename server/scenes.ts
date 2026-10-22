import { HttpError } from "./errors";
import {
  hasOwn,
  parseStoredTags,
  parseStoredTagsStrict,
  validateFavorite,
  validateFolderId,
  validateName,
  validateTags,
} from "./validation";

import type { ServerRuntime } from "./types";

const storedInteger = (value: unknown, minimum: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new HttpError(500, "CORRUPT_SCENE", "画板数据损坏");
  }
  return value;
};

export const storedSceneRevision = (value: unknown) => storedInteger(value, 1);

const parseSceneJson = (value: unknown): any => {
  try {
    if (typeof value !== "string") {
      throw new Error("Missing stored JSON");
    }
    return JSON.parse(value);
  } catch {
    throw new HttpError(500, "CORRUPT_SCENE", "画板数据损坏");
  }
};

export const parseStoredElements = (value: unknown): unknown[] => {
  const elements = parseSceneJson(value);
  if (!Array.isArray(elements)) {
    throw new HttpError(500, "CORRUPT_SCENE", "画板数据损坏");
  }
  return elements;
};

export const parseStoredAppState = (value: unknown): Record<string, unknown> => {
  const appState = parseSceneJson(value);
  if (!appState || typeof appState !== "object" || Array.isArray(appState)) {
    throw new HttpError(500, "CORRUPT_SCENE", "画板数据损坏");
  }
  return appState;
};

export const parseStoredScene = (row: any) => {
  try {
    const elements = parseStoredElements(row.elements);
    const appState = parseStoredAppState(row.app_state);
    return {
      id: row.id,
      name: row.name,
      elements,
      appState,
      created_at: row.created_at,
      updated_at: row.updated_at,
      tags: parseStoredTags(row.tags_json),
      favorite: Boolean(row.is_favorite),
      folder_id: row.folder_id || null,
      last_opened_at: row.last_opened_at || null,
      thumbnail_file_id: row.thumbnail_file_id || null,
      deleted_at: row.deleted_at || null,
      revision: storedSceneRevision(row.revision),
    };
  } catch {
    throw new HttpError(500, "CORRUPT_SCENE", "画板数据损坏");
  }
};

export const getSceneSummary = (row: any) => ({
  id: row.id,
  name: row.name,
  created_at: row.created_at,
  updated_at: row.updated_at,
  revision: storedSceneRevision(row.revision),
  size: row.size === undefined ? undefined : Number(row.size),
  element_count: storedInteger(row.element_count, 0),
  tags: parseStoredTags(row.tags_json),
  favorite: Boolean(row.is_favorite),
  folder_id: row.folder_id || null,
  folder_name: row.folder_name || null,
  last_opened_at: row.last_opened_at || null,
  thumbnail_file_id: row.thumbnail_file_id || null,
  deleted_at: row.deleted_at || null,
});

const sceneFolderQueryCache = new WeakMap<
  ServerRuntime,
  {
    getFolderId: ReturnType<ServerRuntime["db"]["query"]>;
  }
>();

const getFolderQuery = (runtime: ServerRuntime) => {
  let cached = sceneFolderQueryCache.get(runtime);
  if (!cached) {
    cached = {
      getFolderId: runtime.db.query("SELECT id FROM folders WHERE id = ?"),
    };
    sceneFolderQueryCache.set(runtime, cached);
  }
  return cached;
};

const assertFolderExists = (
  runtime: ServerRuntime,
  folderId: string | null,
) => {
  if (
    folderId &&
    !getFolderQuery(runtime).getFolderId.get(folderId)
  ) {
    throw new HttpError(400, "FOLDER_NOT_FOUND", "文件夹不存在");
  }
};

export const parseSceneMetadata = (
  runtime: ServerRuntime,
  body: Record<string, unknown>,
  existing?: any,
) => {
  const name = hasOwn(body, "name")
    ? validateName(body.name)
    : existing?.name || "未命名白板";
  const tags = hasOwn(body, "tags")
    ? validateTags(body.tags)
    : existing
      ? parseStoredTagsStrict(existing.tags_json)
      : [];
  const favorite = hasOwn(body, "favorite")
    ? validateFavorite(body.favorite)
    : Boolean(existing?.is_favorite);
  const folderId = hasOwn(body, "folder_id")
    ? validateFolderId(body.folder_id)
    : existing?.folder_id || null;
  assertFolderExists(runtime, folderId);
  return { name, tags, favorite, folderId };
};

export const sanitizeSceneElements = (elements: unknown[]): unknown[] => {
  if (!Array.isArray(elements)) {
    return [];
  }
  return elements.filter((element) => {
    if (!element || typeof element !== "object") {
      return false;
    }
    return (element as Record<string, unknown>).isDeleted !== true;
  });
};

export const cleanupExpiredTrashScenes = (
  runtime: ServerRuntime,
  retentionDays: number = runtime.config.trashRetentionDays,
): number => {
  if (retentionDays <= 0) {
    return 0;
  }
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const result = runtime.db.run(
    "DELETE FROM scenes WHERE deleted_at IS NOT NULL AND deleted_at < ?",
    [cutoff],
  );
  if (result.changes > 0) {
    console.info(`[Trash] 自动清理了 ${result.changes} 个过期回收站画板`);
    runtime.realtime?.publishWorkspaceChanged(Date.now());
  }
  return result.changes;
};
