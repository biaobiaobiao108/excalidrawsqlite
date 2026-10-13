import { distanceToElement } from "@excalidraw/element/distance";
import { LinearElementEditor } from "@excalidraw/element/linearElementEditor";
import { isArrowElement } from "@excalidraw/element/typeChecks";
import type { ExcalidrawElement, ElementsMap } from "@excalidraw/element/types";
import { elementUpdateSchema, updateDrawingElements } from "./mcp-drawing";

const SCENE_LIMIT = 1_000;
const COMPARISON_LIMIT = 100_000;
const WARNING_LIMIT = 100;
type Endpoint = "startBinding" | "endBinding";
type Warning = { code: string; elementId?: string; endpoint?: Endpoint; message: string };

/** Opt-in only. Bind nearby outlines while retaining the supplied arrow geometry. */
export const autoBindArrowEndpoints = (
  elements: readonly ExcalidrawElement[],
  createdIds: readonly string[],
  options: { maxDistance?: number } = {},
) => {
  const maxDistance = options.maxDistance ?? 24;
  if (!Number.isFinite(maxDistance) || maxDistance < 1 || maxDistance > 100)
    throw new Error("自动绑定 maxDistance 必须在 1–100 像素之间");
  const bindings: { elementId: string; endpoint: Endpoint; targetId: string }[] = [];
  const warnings: Warning[] = [];
  let complete = true, checkedEndpoints = 0, comparisons = 0;
  const warn = (warning: Warning) => {
    if (warnings.length < WARNING_LIMIT) warnings.push(warning);
    else complete = false;
  };
  if (elements.length > SCENE_LIMIT || createdIds.length > SCENE_LIMIT) {
    warn({ code: "AUTO_BIND_LIMIT", message: "场景或新增 ID 超过 1000，已跳过自动绑定；请显式指定 binding" });
    return { elements: [...elements], bindings, warnings, complete: false, checkedEndpoints, maxDistance };
  }
  const active = elements.filter((element) => !element.isDeleted);
  const map = new Map(active.map((element) => [element.id, element])) as ElementsMap;
  const targets = active.filter((element) => ["rectangle", "ellipse", "diamond"].includes(element.type));
  const selected = new Set(createdIds);
  const patches: Parameters<typeof updateDrawingElements>[1][number][] = [];
  for (const arrow of active) {
    if (!isArrowElement(arrow) || !selected.has(arrow.id) || arrow.elbowed) continue;
    const inferred: Partial<Record<Endpoint, string>> = {};
    for (const [endpoint, pointIndex] of [["startBinding", 0], ["endBinding", -1]] as const) {
      if (arrow[endpoint]) continue;
      if (comparisons + targets.length > COMPARISON_LIMIT) {
        complete = false;
        warn({ code: "AUTO_BIND_LIMIT", elementId: arrow.id, endpoint,
          message: "自动绑定达到 100000 次候选比较上限，剩余端点未检查；请显式指定 binding" });
        break;
      }
      checkedEndpoints++;
      const point = LinearElementEditor.getPointAtIndexGlobalCoordinates(arrow, pointIndex, map);
      let closest: { id: string; distance: number } | undefined;
      let secondDistance = Infinity;
      for (const target of targets) {
        comparisons++;
        const distance = distanceToElement(target, map, point);
        if (!Number.isFinite(distance) || distance > maxDistance) continue;
        if (!closest || distance < closest.distance) {
          secondDistance = closest?.distance ?? Infinity;
          closest = { id: target.id, distance };
        } else secondDistance = Math.min(secondDistance, distance);
      }
      if (!closest) continue;
      if (secondDistance - closest.distance <= 2) {
        warn({ code: "AMBIGUOUS_AUTO_BIND", elementId: arrow.id, endpoint,
          message: "端点附近有距离接近的多个形状，未自动绑定；请显式指定 binding" });
        continue;
      }
      inferred[endpoint] = closest.id;
    }
    const start = arrow.startBinding?.elementId ?? inferred.startBinding;
    const end = arrow.endBinding?.elementId ?? inferred.endBinding;
    if (start && start === end && Object.keys(inferred).length) {
      warn({ code: "AMBIGUOUS_AUTO_BIND", elementId: arrow.id,
        message: "两个端点指向同一形状，未推断自连接；请显式指定 binding" });
      continue;
    }
    if (!Object.keys(inferred).length) continue;
    patches.push(elementUpdateSchema.parse({ id: arrow.id,
      ...(inferred.startBinding ? { startBinding: { elementId: inferred.startBinding } } : {}),
      ...(inferred.endBinding ? { endBinding: { elementId: inferred.endBinding } } : {}),
    }));
    for (const [endpoint, targetId] of Object.entries(inferred))
      bindings.push({ elementId: arrow.id, endpoint: endpoint as Endpoint, targetId });
  }
  const result = patches.length ? updateDrawingElements(elements, patches).elements : [...elements];
  return { elements: result, bindings, warnings, complete, checkedEndpoints, maxDistance };
};
