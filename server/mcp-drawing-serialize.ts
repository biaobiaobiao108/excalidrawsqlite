import { newElementWith } from "@excalidraw/element/mutateElement";
import { isArrowElement } from "@excalidraw/element/typeChecks";
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
} from "@excalidraw/element/types";
import { drawingElementSchema, style, type Spec } from "./mcp-drawing-schema";

export const compactElement = (element: ExcalidrawElement) => {
  const fields = element as unknown as Record<string, unknown>;
  return Object.fromEntries(
    [
      "id",
      "type",
      "x",
      "y",
      "width",
      "height",
      "angle",
      "roundness",
      "text",
      "fontSize",
      "fontFamily",
      "textAlign",
      "strokeColor",
      "backgroundColor",
      "fillStyle",
      "strokeWidth",
      "strokeStyle",
      "roughness",
      "opacity",
      "points",
      "containerId",
      "boundElements",
      "startBinding",
      "endBinding",
      "startArrowhead",
      "endArrowhead",
    ]
      .filter((key) => fields[key] !== undefined)
      .map((key) => [key, fields[key]]),
  );
};

/** Writable projection, rather than a dump of editor-only fields. */
export const inputDrawingElements = (current: readonly ExcalidrawElement[]) => {
  const active = current.filter((element) => !element.isDeleted);
  const map = new Map(active.map((element) => [element.id, element]));
  const candidates = new Map<string, Spec>();
  const foldedLabels = new Map<string, string>();
  const unsupported = new Set<string>();
  const warnings: {
    elementId: string;
    fields: string[];
    code?: string;
    message?: string;
  }[] = [];
  const writableStyle = (element: ExcalidrawElement) => ({
    ...Object.fromEntries(
      Object.keys(style)
        .filter((key) => !["rotation", "roundness"].includes(key))
        .map((key) => [
          key,
          (element as unknown as Record<string, unknown>)[key],
        ]),
    ),
    roundness: element.roundness,
    // Degrees are the public input protocol; discard conversion noise while
    // retaining sub-pixel precision for any supported canvas dimension.
    rotation: Number(((element.angle * 180) / Math.PI).toFixed(10)),
  });
  const textStyle = (element: ExcalidrawTextElement) => ({
    ...writableStyle(element),
    fontSize: element.fontSize,
    fontFamily: element.fontFamily,
    textAlign: element.textAlign,
  });
  for (const element of active) {
    const fields: string[] = [];
    if (element.groupIds.length > 8) fields.push("groupIds");
    if (element.frameId) fields.push("frameId");
    if (element.locked) fields.push("locked");
    if (element.link) fields.push("link");
    if (element.customData) fields.push("customData");
    if (isArrowElement(element) && element.elbowed) fields.push("elbowed");
    if (element.type === "text") {
      if (element.verticalAlign !== (element.containerId ? "middle" : "top"))
        fields.push("verticalAlign");
      if (element.containerId && !element.autoResize)
        fields.push("autoResize", "width");
    }
    if (fields.length) warnings.push({ elementId: element.id, fields });
    const base = {
      id: element.id,
      type: element.type,
      ...writableStyle(element),
      ...(element.groupIds.length <= 8 && element.groupIds.length
        ? { groupIds: [...element.groupIds] }
        : {}),
    };
    let candidate: Record<string, unknown>;
    if (["rectangle", "ellipse", "diamond"].includes(element.type)) {
      candidate = {
        ...base,
        x: element.x,
        y: element.y,
        width: element.width,
        height: element.height,
      };
      const labelId = element.boundElements?.find(
        (bound) => bound.type === "text",
      )?.id;
      const label = labelId ? map.get(labelId) : undefined;
      if (label?.type === "text" && label.containerId === element.id) {
        candidate.text = label.originalText;
        candidate.labelId = label.id;
        candidate.labelStyle = textStyle(label);
        foldedLabels.set(label.id, element.id);
        if (label.angle !== element.angle)
          warnings.push({ elementId: label.id, fields: ["rotation"] });
      }
    } else if (element.type === "text") {
      // Container text is folded by its shape; unsupported containers are
      // reported below instead of accidentally turning labels into free text.
      if (element.containerId) continue;
      candidate = {
        ...base,
        x: element.x,
        y: element.y,
        text: element.originalText,
        ...textStyle(element),
        ...(!element.autoResize
          ? { width: element.width, autoResize: false }
          : {}),
      };
    } else if (element.type === "line" || element.type === "arrow") {
      candidate = {
        ...base,
        x: element.x,
        y: element.y,
        points: element.points.map(([x, y]) => [x, y]),
      };
      if (element.type === "arrow")
        Object.assign(candidate, {
          startBinding: element.startBinding,
          endBinding: element.endBinding,
          startArrowhead: element.startArrowhead,
          endArrowhead: element.endArrowhead,
        });
    } else {
      unsupported.add(element.id);
      warnings.push({
        elementId: element.id,
        fields: ["type"],
        code: "UNSUPPORTED_ELEMENT_TYPE",
        message: `input 视图不支持 ${element.type} 图元；该图元仍在画板中，未删除`,
      });
      continue;
    }
    const parsed = drawingElementSchema.safeParse(candidate);
    if (parsed.success) candidates.set(element.id, parsed.data);
    else {
      unsupported.add(element.id);
      warnings.push({
        elementId: element.id,
        fields: [
          ...new Set(
            parsed.error.issues.map(
              (issue) => issue.path.join(".") || "element",
            ),
          ),
        ],
        code: "UNWRITABLE_ELEMENT",
        message: `图元不符合可写 schema，input 视图已跳过；该图元仍在画板中，未删除：${parsed.error.issues.map((issue) => `${issue.path.join(".") || "element"}: ${issue.message}`).join("；")}`,
      });
    }
  }
  for (const element of active) {
    if (
      element.type === "text" &&
      element.containerId &&
      !candidates.has(foldedLabels.get(element.id) || "")
    ) {
      unsupported.add(element.id);
      warnings.push({
        elementId: element.id,
        fields: ["containerId"],
        code: "UNWRITABLE_LABEL_CONTAINER",
        message: `绑定文字的容器 ${element.containerId} 未能投影到 input 视图；文字仍在画板中，未删除`,
      });
    }
  }
  // A projected arrow must not reference a target omitted from the projection.
  // Remove dependent arrows transitively, reporting all missing elements.
  let changed = true;
  while (changed) {
    changed = false;
    const available = new Set([
      ...candidates.keys(),
      ...[...foldedLabels]
        .filter(([, parentId]) => candidates.has(parentId))
        .map(([labelId]) => labelId),
    ]);
    for (const [id, spec] of candidates) {
      if (
        spec.type === "arrow" &&
        [spec.startBinding, spec.endBinding].some(
          (bound) => bound && !available.has(bound.elementId),
        )
      ) {
        candidates.delete(id);
        unsupported.add(id);
        warnings.push({
          elementId: id,
          fields: ["startBinding", "endBinding"],
          code: "UNWRITABLE_BINDING_TARGET",
          message:
            "箭头绑定了未能投影到 input 视图的目标，已跳过箭头；箭头仍在画板中，未删除",
        });
        changed = true;
      }
    }
  }
  return {
    elements: [...candidates.values()],
    labelOwners: new Map(
      [...foldedLabels].filter(([, parentId]) => candidates.has(parentId)),
    ),
    unsupportedElementIds: [...unsupported],
    warnings,
  };
};

export const removeDrawingElements = (
  current: readonly ExcalidrawElement[],
  requestedIds: readonly string[],
) => {
  const requested = new Set(requestedIds);
  const currentIds = new Set(current.map((element) => element.id));
  const notFoundIds = [...requested].filter((id) => !currentIds.has(id));
  const childrenByContainer = new Map<string, string[]>();
  for (const element of current) {
    const containerId = (
      element as ExcalidrawElement & { containerId?: string | null }
    ).containerId;
    if (!containerId) {
      continue;
    }
    const list = childrenByContainer.get(containerId);
    if (list) {
      list.push(element.id);
    } else {
      childrenByContainer.set(containerId, [element.id]);
    }
  }
  const idsToRemove = new Set(requested);
  for (const element of current) {
    if (!idsToRemove.has(element.id)) {
      continue;
    }
    const fields = element as ExcalidrawElement & {
      boundElements?: Array<{ id: string; type: string }> | null;
    };
    for (const bound of fields.boundElements || []) {
      if (bound.type === "text") {
        idsToRemove.add(bound.id);
      }
    }
    for (const childId of childrenByContainer.get(element.id) || []) {
      idsToRemove.add(childId);
    }
  }

  const remaining = current.filter((element) => !idsToRemove.has(element.id));
  const remainingIds = new Set(remaining.map((element) => element.id));
  const cleaned = remaining.map((element) => {
    const fields = element as ExcalidrawElement & {
      boundElements?: Array<{ id: string; type: string }> | null;
      containerId?: string | null;
      startBinding?: { elementId: string } | null;
      endBinding?: { elementId: string } | null;
    };
    const updates: Record<string, unknown> = {};
    if (Array.isArray(fields.boundElements)) {
      const boundElements = fields.boundElements.filter((bound) =>
        remainingIds.has(bound.id),
      );
      if (boundElements.length !== fields.boundElements.length) {
        updates.boundElements = boundElements.length ? boundElements : null;
      }
    }
    for (const bindingKey of ["startBinding", "endBinding"] as const) {
      const binding = fields[bindingKey];
      if (binding && !remainingIds.has(binding.elementId)) {
        updates[bindingKey] = null;
      }
    }
    if (fields.containerId && !remainingIds.has(fields.containerId)) {
      updates.containerId = null;
    }
    return Object.keys(updates).length
      ? newElementWith(element, updates as never)
      : element;
  });

  return {
    elements: cleaned,
    removedCount: current.length - remaining.length,
    requestedRemovedCount: current.filter((element) =>
      requested.has(element.id),
    ).length,
    cascadeRemovedCount: current.filter(
      (element) => idsToRemove.has(element.id) && !requested.has(element.id),
    ).length,
    notFoundIds,
  };
};
