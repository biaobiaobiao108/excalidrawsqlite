import { HttpError } from "./errors";
import {
  hasOwn,
  parseStoredTags,
  validateFavorite,
  validateFolderId,
  validateName,
  validateTags,
} from "./validation";

import type { ServerRuntime } from "./types";

export const parseStoredScene = (row: any) => {
  try {
    return {
      id: row.id,
      name: row.name,
      elements: JSON.parse(row.elements || "[]"),
      appState: JSON.parse(row.app_state || "{}"),
      created_at: row.created_at,
      updated_at: row.updated_at,
      tags: parseStoredTags(row.tags_json),
      favorite: Boolean(row.is_favorite),
      folder_id: row.folder_id || null,
      last_opened_at: row.last_opened_at || null,
      thumbnail_file_id: row.thumbnail_file_id || null,
      deleted_at: row.deleted_at || null,
      revision: Number(row.revision) || 1,
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
  revision: Number(row.revision) || 1,
  size: row.size === undefined ? undefined : Number(row.size),
  element_count:
    row.element_count !== undefined && row.element_count !== null
      ? Number(row.element_count)
      : typeof row.elements === "string"
      ? (JSON.parse(row.elements || "[]") || []).length
      : Array.isArray(row.elements)
      ? row.elements.length
      : 0,
  tags: parseStoredTags(row.tags_json),
  favorite: Boolean(row.is_favorite),
  folder_id: row.folder_id || null,
  folder_name: row.folder_name || null,
  last_opened_at: row.last_opened_at || null,
  thumbnail_file_id: row.thumbnail_file_id || null,
  deleted_at: row.deleted_at || null,
});

const assertFolderExists = (
  runtime: ServerRuntime,
  folderId: string | null,
) => {
  if (
    folderId &&
    !runtime.db.query("SELECT id FROM folders WHERE id = ?").get(folderId)
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
    : parseStoredTags(existing?.tags_json);
  const favorite = hasOwn(body, "favorite")
    ? validateFavorite(body.favorite)
    : Boolean(existing?.is_favorite);
  const folderId = hasOwn(body, "folder_id")
    ? validateFolderId(body.folder_id)
    : existing?.folder_id || null;
  assertFolderExists(runtime, folderId);
  return { name, tags, favorite, folderId };
};
