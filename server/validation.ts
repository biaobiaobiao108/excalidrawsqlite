import {
  FILE_ID_PATTERN,
  MIME_TYPE_PATTERN,
  MAX_BATCH_FILES,
  MAX_FOLDER_NAME_LENGTH,
  MAX_SCENE_NAME_LENGTH,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  SCENE_ID_PATTERN,
} from "./config";
import { HttpError } from "./errors";

export const hasOwn = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const validateId = (value: unknown, kind: "file" | "scene") => {
  const pattern = kind === "file" ? FILE_ID_PATTERN : SCENE_ID_PATTERN;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new HttpError(400, "INVALID_ID", "无效的资源 ID");
  }
  return value;
};

export const validateName = (value: unknown) => {
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_NAME", "画板名称必须是字符串");
  }
  const name = value.trim();
  if (!name || name.length > MAX_SCENE_NAME_LENGTH) {
    throw new HttpError(
      400,
      "INVALID_NAME",
      "画板名称不能为空且不能超过 120 个字符",
    );
  }
  return name;
};

export const validateFolderName = (value: unknown) => {
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_FOLDER_NAME", "文件夹名称必须是字符串");
  }
  const name = value.trim();
  if (!name || name.length > MAX_FOLDER_NAME_LENGTH) {
    throw new HttpError(
      400,
      "INVALID_FOLDER_NAME",
      `文件夹名称不能为空且不能超过 ${MAX_FOLDER_NAME_LENGTH} 个字符`,
    );
  }
  return name;
};

export const validateTags = (value: unknown) => {
  if (!Array.isArray(value) || value.length > MAX_TAGS) {
    throw new HttpError(
      400,
      "INVALID_TAGS",
      `标签必须是数组且不能超过 ${MAX_TAGS} 个`,
    );
  }
  const tags = [
    ...new Set(
      value.map((tag) => {
        if (typeof tag !== "string") {
          throw new HttpError(400, "INVALID_TAGS", "标签必须是字符串");
        }
        const normalized = tag.trim();
        if (!normalized || normalized.length > MAX_TAG_LENGTH) {
          throw new HttpError(
            400,
            "INVALID_TAGS",
            `标签不能为空且不能超过 ${MAX_TAG_LENGTH} 个字符`,
          );
        }
        return normalized;
      }),
    ),
  ];
  return tags;
};

export const validateFavorite = (value: unknown) => {
  if (typeof value !== "boolean") {
    throw new HttpError(400, "INVALID_FAVORITE", "收藏状态必须是布尔值");
  }
  return value;
};

export const validateFolderId = (value: unknown) => {
  if (value === null || value === "") {
    return null;
  }
  return validateId(value, "scene");
};

export const parseStoredTags = (value: unknown) => {
  try {
    return validateTags(JSON.parse(String(value || "[]")));
  } catch {
    return [];
  }
};

export const validateElements = (value: unknown) => {
  if (!Array.isArray(value)) {
    throw new HttpError(400, "INVALID_ELEMENTS", "图元数据必须是数组");
  }
  return value;
};

export const validateAppState = (value: unknown) => {
  if (!isRecord(value)) {
    throw new HttpError(400, "INVALID_APP_STATE", "应用状态必须是对象");
  }
  return value;
};

export const getPathId = (
  pathname: string,
  prefix: string,
  kind: "file" | "scene",
) => {
  const rawId = pathname.slice(prefix.length);
  if (!rawId || rawId.includes("/")) {
    throw new HttpError(400, "INVALID_ID", "无效的资源 ID");
  }
  let id = "";
  try {
    id = decodeURIComponent(rawId);
  } catch {
    throw new HttpError(400, "INVALID_ID", "无效的资源 ID");
  }
  return validateId(id, kind);
};

export const isSafeMimeType = (value: unknown) =>
  typeof value === "string" &&
  MIME_TYPE_PATTERN.test(value) &&
  value.toLowerCase() !== "image/svg+xml" &&
  (value.toLowerCase().startsWith("image/") ||
    value.toLowerCase() === "application/octet-stream");

export const validateMimeType = (value: unknown) => {
  if (!isSafeMimeType(value)) {
    throw new HttpError(
      415,
      "INVALID_MIME_TYPE",
      "不支持 SVG 图片，仅支持栅格图片或二进制附件",
    );
  }
  return value as string;
};

export const requireJsonObject = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new HttpError(400, "INVALID_BODY", "请求体必须是对象");
  }
  return value;
};

export const requireRevision = (value: unknown) => {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new HttpError(400, "INVALID_REVISION", "revision 必须是正整数");
  }
  return value as number;
};

export const parseFileUploadEntries = (body: Record<string, unknown>) => {
  if (hasOwn(body, "id") || hasOwn(body, "dataURL")) {
    if (typeof body.id !== "string") {
      throw new HttpError(400, "INVALID_ID", "无效的文件 ID");
    }
    return [[body.id, body]] as Array<[string, unknown]>;
  }
  const entries = Object.entries(body);
  if (entries.length > MAX_BATCH_FILES) {
    throw new HttpError(413, "TOO_MANY_FILES", "单次上传的文件数量过多");
  }
  return entries;
};
