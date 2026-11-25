import * as z from "zod/v4";

import type { HttpError } from "./errors";
import { measureMcpPhase } from "./mcp-trace";

import type { ExcalidrawElement } from "@excalidraw/element/types";

const recoveryActions: Readonly<Partial<Record<string, string>>> = {
  REVISION_CONFLICT:
    "重新读取画板，核对最新 revision 后使用 expectedRevision 重试。",
  SCENE_SELECTION_STALE: "重新读取画板及其修订号，核对后重试。",
  FOLDER_NAME_EXISTS: "用 ensure_folder 复用现有文件夹，或换一个名称。",
  FOLDER_CHANGED: "重新读取文件夹及画板数量，核对后重试。",
  IDEMPOTENCY_KEY_CONFLICT: "原参数重试时复用原 key，修改参数时换一个 key。",
  IDEMPOTENT_BOARD_DELETED:
    "使用 restore_board 恢复原画板，或换一个 key 创建新画板。",
  READ_BUDGET_EXHAUSTED: "使用 get_board 单独读取该画板。",
  READ_BUDGET_TOO_SMALL: "增大 maxChars、减少读取范围，或改用摘要视图。",
};

const notFoundTargets: Readonly<Partial<Record<string, string>>> = {
  SCENE_NOT_FOUND: "board",
  FOLDER_NOT_FOUND: "folder",
  ELEMENT_NOT_FOUND: "element",
};

const notFoundActions: Readonly<Partial<Record<string, string>>> = {
  board: "使用 list_boards 找到画板；若在回收站，先用 restore_board 恢复。",
  folder: "使用 list_folders 找到文件夹，再用正确的 ID 操作。",
  element: "使用 get_board 读取最新图元 ID，再用正确的 ID 操作。",
};

export const mcpError = (error: HttpError) => ({
  code: error.code,
  message: error.message,
  ...error.details,
});

const normalizeMcpError = (value: Record<string, unknown>) => {
  const originalCode = String(value.code);
  const missingTarget = Object.hasOwn(notFoundTargets, originalCode)
    ? notFoundTargets[originalCode]
    : undefined;
  const code = missingTarget ? "NOT_FOUND" : originalCode;
  const target = missingTarget ?? value.target;
  const suggestedAction =
    code === "NOT_FOUND" &&
    typeof target === "string" &&
    Object.hasOwn(notFoundActions, target)
      ? notFoundActions[target]
      : Object.hasOwn(recoveryActions, code)
        ? recoveryActions[code]
        : undefined;
  return {
    ...value,
    code,
    ...(target === undefined ? {} : { target }),
    recoverable: suggestedAction !== undefined,
    ...(suggestedAction ? { suggestedAction } : {}),
  };
};

export const projectMcpRecord = (
  value: Record<string, unknown>,
  publicOrigin?: string,
): Record<string, unknown> => {
  const { thumbnail_file_id: _thumbnail, size: _size, ...clean } = value;
  if (typeof value.id === "string" && typeof value.revision === "number") {
    clean.boardId = value.id;
    delete clean.id;
  }
  if (typeof clean.boardId === "string") {
    for (const [stored, exposed] of [
      ["element_count", "elementCount"],
      ["folder_id", "folderId"],
      ["folder_name", "folderName"],
      ["created_at", "createdAt"],
      ["updated_at", "updatedAt"],
      ["last_opened_at", "lastOpenedAt"],
      ["deleted_at", "deletedAt"],
    ]) {
      if (Object.hasOwn(clean, stored)) {
        clean[exposed] = clean[stored];
        delete clean[stored];
      }
    }
    if (publicOrigin && !clean.error && clean.ok !== false) {
      const url = new URL("/", publicOrigin);
      url.searchParams.set("id", clean.boardId);
      clean.webUrl = url.href;
    }
  }
  if (typeof clean.icon === "string" && typeof clean.id === "string") {
    for (const [stored, exposed] of [
      ["scene_count", "boardCount"],
      ["created_at", "createdAt"],
      ["updated_at", "updatedAt"],
    ]) {
      if (Object.hasOwn(clean, stored)) {
        clean[exposed] = clean[stored];
        delete clean[stored];
      }
    }
  }
  for (const key of ["createdAt", "updatedAt", "lastOpenedAt", "deletedAt"]) {
    const timestamp = clean[key];
    if (typeof timestamp !== "number") continue;
    // SQLite stores Unix milliseconds.
    const date = new Date(timestamp);
    if (Number.isFinite(date.getTime()))
      clean[`${key}ISO`] = date.toISOString();
  }
  if (Object.hasOwn(clean, "deletedAt"))
    clean.isDeleted = clean.deletedAt !== null;
  if (clean.error && typeof clean.error === "object") {
    clean.error = normalizeMcpError(clean.error as Record<string, unknown>);
  }
  return clean;
};

export const result = (value: Record<string, unknown>, publicOrigin?: string) =>
  measureMcpPhase("responseBuildMs", () => {
    const results = Array.isArray(value.results) ? value.results : undefined;
    const boards = Array.isArray(value.boards) ? value.boards : undefined;
    const failed = (results ?? boards)?.some((entry) => entry.ok === false);
    const projected = projectMcpRecord(value, publicOrigin);
    const structuredContent = {
      ...projected,
      ...Object.fromEntries(
        ["items", "boards", "results", "folders"]
          .filter((key) => Array.isArray(value[key]))
          .map((key) => [
            key,
            (value[key] as Record<string, unknown>[]).map((entry) =>
              projectMcpRecord(entry, publicOrigin),
            ),
          ]),
      ),
      ...(value.folder && typeof value.folder === "object"
        ? { folder: projectMcpRecord(value.folder as Record<string, unknown>) }
        : {}),
      ok: !value.error && !failed,
    };
    const error = projected.error as { recoverable?: boolean } | undefined;
    return {
      structuredContent,
      content: [] as Array<{ type: "text"; text: string }>,
      ...(error && !error.recoverable ? { isError: true as const } : {}),
    };
  });

export const responseModeSchema = z
  .enum(["minimal", "ids"])
  .optional()
  .describe(
    "默认 minimal 返回修订号、数量及已配置的 webUrl；ids 另含图元 ID 与 inputIndex 映射",
  );

export const drawingReceipt = (
  created: readonly ExcalidrawElement[],
  mode: "minimal" | "ids" = "minimal",
) => {
  if (mode === "minimal") return { addedCount: created.length };
  const ids = new Set(created.map((element) => element.id));
  const generated = created.filter(
    (element) =>
      element.type === "text" &&
      element.containerId &&
      ids.has(element.containerId),
  );
  const generatedIds = new Set(generated.map((element) => element.id));
  const requested = created.filter((element) => !generatedIds.has(element.id));
  return {
    addedCount: created.length,
    requestedElementIds: requested.map((element) => element.id),
    generatedElementIds: generated.map((element) => element.id),
    elementMap: requested.map((element, inputIndex) => ({
      inputIndex,
      elementId: element.id,
      ...(element.boundElements?.find((bound) => bound.type === "text")
        ? {
            labelId: element.boundElements.find(
              (bound) => bound.type === "text",
            )!.id,
          }
        : {}),
    })),
  };
};

export const positionReceipt = (
  elements: readonly ExcalidrawElement[],
  id: string,
) => {
  const element = elements.find((item) => item.id === id && !item.isDeleted);
  if (!element) return { elementId: id };
  const geometry = (item: ExcalidrawElement) => ({
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
  });
  const labelId = element.boundElements?.find(
    (bound) => bound.type === "text",
  )?.id;
  const label = labelId
    ? elements.find((item) => item.id === labelId && !item.isDeleted)
    : undefined;
  return {
    elementId: id,
    ...geometry(element),
    ...(label ? { label: { id: label.id, ...geometry(label) } } : {}),
  };
};
