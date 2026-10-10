import type { ExcalidrawElement } from "@excalidraw/element/types";

/** Semantic read view: preserve every active object, fold owned labels, omit paint/editor state. */
export const compactDrawingElements = (current: readonly ExcalidrawElement[]) => {
  const active = current.filter((element) => !element.isDeleted);
  const map = new Map(active.map((element) => [element.id, element]));
  const labels = new Map<string, ExcalidrawElement & { type: "text" }>();
  const labelOwners = new Map<string, string>();
  for (const element of active) {
    if (element.type !== "text" || !element.containerId) continue;
    const owner = map.get(element.containerId);
    if (!owner?.boundElements?.some((bound) => bound.type === "text" && bound.id === element.id)) continue;
    // Malformed scenes with multiple labels still expose every extra text object.
    if (labels.has(owner.id)) continue;
    labels.set(owner.id, element);
    labelOwners.set(element.id, owner.id);
  }
  const elements = active.filter((element) => !labelOwners.has(element.id)).map((element) => {
    const label = labels.get(element.id);
    const fields = element as unknown as Record<string, unknown>;
    return {
      id: element.id, type: element.type,
      x: element.x, y: element.y, width: element.width, height: element.height,
      ...(element.angle ? { rotation: Number((element.angle * 180 / Math.PI).toFixed(10)) } : {}),
      ...(label ? { text: label.originalText, labelId: label.id }
        : element.type === "text" ? { text: element.originalText,
            ...(element.containerId ? { containerId: element.containerId } : {}) } : {}),
      ...("points" in element ? { points: element.points.map(([x, y]) => [element.x + x, element.y + y]) } : {}),
      ...(element.type === "arrow" ? {
        ...(element.startBinding ? { startBinding: { elementId: element.startBinding.elementId } } : {}),
        ...(element.endBinding ? { endBinding: { elementId: element.endBinding.elementId } } : {}),
        startArrowhead: element.startArrowhead, endArrowhead: element.endArrowhead,
      } : {}),
      ...(element.frameId ? { frameId: element.frameId } : {}),
      ...(typeof fields.name === "string" ? { name: fields.name } : {}),
      ...(typeof fields.link === "string" ? { link: fields.link } : {}),
    };
  });
  return { elements, labelOwners };
};
