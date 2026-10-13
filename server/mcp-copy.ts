import { randomBase64Url } from "./crypto";
import { HttpError } from "./errors";
import { drawingElementSchema, inputDrawingElements } from "./mcp-drawing";

import type { ExcalidrawElement } from "@excalidraw/element/types";

/** Copy writable objects without retaining a second native scene or rewriting client IDs. */
export const copyDrawingSelection = (
  current: readonly ExcalidrawElement[],
  requestedIds: readonly string[],
  target: readonly ExcalidrawElement[],
  dx: number,
  dy: number,
  preserveExternalBindings: boolean,
) => {
  const active = new Map(current.filter((element) => !element.isDeleted).map((element) => [element.id, element]));
  const projection = inputDrawingElements(current);
  const specs = new Map(projection.elements.map((element) => [element.id!, element]));
  const owners = new Map<string, string>();
  for (const spec of projection.elements) {
    if ((spec.type === "rectangle" || spec.type === "ellipse" || spec.type === "diamond") && spec.labelId)
      owners.set(spec.labelId, spec.id!);
  }
  const selected = new Set<string>();
  for (const id of requestedIds) {
    if (!active.has(id)) throw new HttpError(404, "ELEMENT_NOT_FOUND", `图元不存在：${id}`);
    const owner = owners.get(id) || id;
    if (!specs.has(owner))
      throw new HttpError(422, "UNSUPPORTED_COPY_SELECTION", `图元 ${id} 不能复制为 MCP 可写描述；请用 get_board.view=input 查看 warnings`);
    selected.add(owner);
  }
  const usedIds = new Set(target.map((element) => element.id));
  const usedGroupIds = new Set(target.flatMap((element) => [...element.groupIds]));
  const groupIdMap: Record<string, string> = Object.create(null);
  const copyGroup = (id: string) => {
    if (groupIdMap[id]) return groupIdMap[id];
    let next: string;
    do { next = `group_${randomBase64Url(12)}`; } while (usedGroupIds.has(next));
    usedGroupIds.add(next);
    return groupIdMap[id] = next;
  };
  const idMap: Record<string, string> = Object.create(null);
  const allocate = (id: string) => {
    if (idMap[id]) return idMap[id];
    let next: string;
    do { next = `copy_${randomBase64Url(12)}`; } while (usedIds.has(next));
    usedIds.add(next);
    idMap[id] = next;
    return next;
  };
  // Allocate all IDs first so arrows may precede their targets in scene order.
  for (const id of selected) {
    allocate(id);
    const spec = specs.get(id)!;
    if ((spec.type === "rectangle" || spec.type === "ellipse" || spec.type === "diamond") && spec.labelId)
      allocate(spec.labelId);
  }
  const elements = projection.elements.filter((spec) => selected.has(spec.id!)).map((spec) => {
    const copied = { ...spec, id: idMap[spec.id!] };
    if (copied.groupIds) copied.groupIds = copied.groupIds.map(copyGroup);
    if (copied.type === "line" || copied.type === "arrow") {
      copied.points = copied.points!.map(([x, y]) => [x + dx, y + dy]);
      if (copied.type === "arrow") {
        for (const key of ["startBinding", "endBinding"] as const) {
          const bound = copied[key];
          if (!bound) continue;
          copied[key] = idMap[bound.elementId]
            ? { ...bound, elementId: idMap[bound.elementId] }
            : preserveExternalBindings ? bound : null;
        }
      }
    } else {
      copied.x += dx;
      copied.y += dy;
      if (copied.type !== "text" && copied.labelId) copied.labelId = idMap[copied.labelId];
    }
    const parsed = drawingElementSchema.safeParse(copied);
    if (!parsed.success)
      throw new HttpError(400, "INVALID_COPY_OFFSET", "复制位移导致坐标超出允许范围，请减小 dx/dy");
    return parsed.data;
  });
  const warnings = projection.warnings.filter((warning) => Object.hasOwn(idMap, warning.elementId));
  return { elements, idMap, groupIdMap, warnings };
};
