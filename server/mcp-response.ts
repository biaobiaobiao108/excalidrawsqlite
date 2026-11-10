import * as z from "zod/v4";

import { measureMcpPhase } from "./mcp-trace";

import type { ExcalidrawElement } from "@excalidraw/element/types";

export const cleanBoardRecord = (
  value: Record<string, unknown>,
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
  return clean;
};

export const result = (value: Record<string, unknown>) =>
  measureMcpPhase("responseBuildMs", () => {
    const structuredContent = {
      ok: !value.error,
      ...cleanBoardRecord(value),
      ...Object.fromEntries(
        ["items", "boards", "results", "folders"]
          .filter((key) => Array.isArray(value[key]))
          .map((key) => [
            key,
            (value[key] as Record<string, unknown>[]).map(cleanBoardRecord),
          ]),
      ),
      ...(value.folder && typeof value.folder === "object"
        ? { folder: cleanBoardRecord(value.folder as Record<string, unknown>) }
        : {}),
    };
    return {
      structuredContent,
      content: [] as Array<{ type: "text"; text: string }>,
    };
  });

export const responseModeSchema = z
  .enum(["minimal", "ids"])
  .optional()
  .describe(
    "默认 minimal 仅返回修订号/数量/URL；ids 另含图元 ID 与 inputIndex 映射",
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
