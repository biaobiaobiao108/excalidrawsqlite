import { distanceToElement } from "@excalidraw/element/distance";
import { LinearElementEditor } from "@excalidraw/element/linearElementEditor";
import { isArrowElement } from "@excalidraw/element/typeChecks";
import type { ExcalidrawElement, ElementsMap } from "@excalidraw/element/types";
import { elementUpdateSchema, updateDrawingElements } from "./mcp-drawing";

const SCENE_LIMIT = 1_000;
const COMPARISON_LIMIT = 100_000;
const WARNING_LIMIT = 100;
const POINT_LIMIT = 200_000;
const ARROW_POINT_LIMIT = 10_000;
type Endpoint = "startBinding" | "endBinding";
type Warning = {
  code: string;
  elementId?: string;
  endpoint?: Endpoint;
  message: string;
};

/** Opt-in only. Bind nearby outlines while retaining the supplied arrow geometry. */
export const autoBindArrowEndpoints = (
  elements: readonly ExcalidrawElement[],
  createdIds: readonly string[],
  options: { maxDistance?: number } = {},
) => {
  const maxDistance = options.maxDistance ?? 24;
  if (!Number.isFinite(maxDistance) || maxDistance < 1 || maxDistance > 100)
    throw new Error("自动绑定 maxDistance 必须在 1–100 像素之间");
  const bindings: {
    elementId: string;
    endpoint: Endpoint;
    targetId: string;
  }[] = [];
  const warnings: Warning[] = [];
  let complete = true,
    checkedEndpoints = 0,
    comparisons = 0,
    checkedPoints = 0;
  const warn = (warning: Warning) => {
    if (warnings.length < WARNING_LIMIT) warnings.push(warning);
    else complete = false;
  };
  if (elements.length > SCENE_LIMIT || createdIds.length > SCENE_LIMIT) {
    warn({
      code: "AUTO_BIND_LIMIT",
      message: "场景或新增 ID 超过 1000，已跳过自动绑定；请显式指定 binding",
    });
    return {
      elements: [...elements],
      bindings,
      warnings,
      complete: false,
      checkedEndpoints,
      checkedPoints,
      comparisons,
      maxDistance,
    };
  }
  const active = elements.filter((element) => {
    if (
      !element ||
      typeof element !== "object" ||
      typeof element.id !== "string" ||
      typeof element.type !== "string"
    ) {
      complete = false;
      warn({
        code: "INVALID_AUTO_BIND_GEOMETRY",
        message: "场景含不完整图元，已跳过该自动绑定候选；新增图元仍可保存",
      });
      return false;
    }
    return !element.isDeleted;
  });
  const map = new Map(
    active.map((element) => [element.id, element]),
  ) as ElementsMap;
  const targets = active.filter((element) => {
    if (!["rectangle", "ellipse", "diamond"].includes(element.type))
      return false;
    if (
      ![
        element.x,
        element.y,
        element.width,
        element.height,
        element.angle,
      ].every(Number.isFinite) ||
      element.width <= 0 ||
      element.height <= 0
    ) {
      complete = false;
      warn({
        code: "INVALID_AUTO_BIND_GEOMETRY",
        elementId: element.id,
        message: "形状几何无效，已跳过自动绑定候选；新增图元仍可保存",
      });
      return false;
    }
    return true;
  });
  const invalidTargets = new Set<string>();
  const selected = new Set(createdIds);
  const patches: Parameters<typeof updateDrawingElements>[1][number][] = [];
  for (const arrow of active) {
    if (
      !isArrowElement(arrow) ||
      !selected.has(arrow.id) ||
      arrow.elbowed ||
      (arrow.startBinding && arrow.endBinding)
    )
      continue;
    if (
      !Array.isArray(arrow.points) ||
      arrow.points.length < 2 ||
      ![arrow.x, arrow.y, arrow.width, arrow.height, arrow.angle].every(
        Number.isFinite,
      )
    ) {
      complete = false;
      warn({
        code: "INVALID_AUTO_BIND_GEOMETRY",
        elementId: arrow.id,
        message: "箭头几何无效，已跳过自动绑定；新增图元仍可保存",
      });
      continue;
    }
    if (
      arrow.points.length > ARROW_POINT_LIMIT ||
      checkedPoints + arrow.points.length > POINT_LIMIT
    ) {
      complete = false;
      warn({
        code: "AUTO_BIND_LIMIT",
        elementId: arrow.id,
        message: "箭头点检查达到容量上限，已跳过自动绑定；请显式指定 binding",
      });
      continue;
    }
    checkedPoints += arrow.points.length;
    if (
      arrow.points.some(
        (point) =>
          !Array.isArray(point) ||
          point.length !== 2 ||
          !point.every(Number.isFinite),
      )
    ) {
      complete = false;
      warn({
        code: "INVALID_AUTO_BIND_GEOMETRY",
        elementId: arrow.id,
        message: "箭头包含无效点，已跳过自动绑定；新增图元仍可保存",
      });
      continue;
    }
    const inferred: Partial<Record<Endpoint, string>> = {};
    for (const [endpoint, pointIndex] of [
      ["startBinding", 0],
      ["endBinding", -1],
    ] as const) {
      if (arrow[endpoint]) continue;
      if (comparisons + targets.length > COMPARISON_LIMIT) {
        complete = false;
        warn({
          code: "AUTO_BIND_LIMIT",
          elementId: arrow.id,
          endpoint,
          message:
            "自动绑定达到 100000 次候选比较上限，剩余端点未检查；请显式指定 binding",
        });
        break;
      }
      checkedEndpoints++;
      if (checkedPoints + arrow.points.length > POINT_LIMIT) {
        complete = false;
        warn({
          code: "AUTO_BIND_LIMIT",
          elementId: arrow.id,
          endpoint,
          message:
            "箭头端点计算达到点容量上限，已跳过剩余端点；请显式指定 binding",
        });
        break;
      }
      checkedPoints += arrow.points.length;
      let point: ReturnType<
        typeof LinearElementEditor.getPointAtIndexGlobalCoordinates
      >;
      try {
        point = LinearElementEditor.getPointAtIndexGlobalCoordinates(
          arrow,
          pointIndex,
          map,
        );
      } catch {
        complete = false;
        warn({
          code: "INVALID_AUTO_BIND_GEOMETRY",
          elementId: arrow.id,
          endpoint,
          message: "原生箭头端点无法解析，已跳过自动绑定；新增图元仍可保存",
        });
        continue;
      }
      if (!point.every(Number.isFinite)) {
        complete = false;
        warn({
          code: "INVALID_AUTO_BIND_GEOMETRY",
          elementId: arrow.id,
          endpoint,
          message: "原生箭头端点坐标无效，已跳过自动绑定；新增图元仍可保存",
        });
        continue;
      }
      let closest: { id: string; distance: number } | undefined;
      let secondDistance = Infinity;
      for (const target of targets) {
        comparisons++;
        if (invalidTargets.has(target.id)) continue;
        let distance: number;
        try {
          distance = distanceToElement(target, map, point);
        } catch {
          complete = false;
          invalidTargets.add(target.id);
          warn({
            code: "INVALID_AUTO_BIND_GEOMETRY",
            elementId: target.id,
            message:
              "原生形状轮廓无法解析，已跳过该自动绑定候选；新增图元仍可保存",
          });
          continue;
        }
        if (!Number.isFinite(distance)) {
          complete = false;
          invalidTargets.add(target.id);
          warn({
            code: "INVALID_AUTO_BIND_GEOMETRY",
            elementId: target.id,
            message:
              "原生形状轮廓距离无效，已跳过该自动绑定候选；新增图元仍可保存",
          });
          continue;
        }
        if (distance > maxDistance) continue;
        if (!closest || distance < closest.distance) {
          secondDistance = closest?.distance ?? Infinity;
          closest = { id: target.id, distance };
        } else secondDistance = Math.min(secondDistance, distance);
      }
      if (!closest) continue;
      if (secondDistance - closest.distance <= 2) {
        warn({
          code: "AMBIGUOUS_AUTO_BIND",
          elementId: arrow.id,
          endpoint,
          message:
            "端点附近有距离接近的多个形状，未自动绑定；请显式指定 binding",
        });
        continue;
      }
      inferred[endpoint] = closest.id;
    }
    const start = arrow.startBinding?.elementId ?? inferred.startBinding;
    const end = arrow.endBinding?.elementId ?? inferred.endBinding;
    if (start && start === end && Object.keys(inferred).length) {
      warn({
        code: "AMBIGUOUS_AUTO_BIND",
        elementId: arrow.id,
        message: "两个端点指向同一形状，未推断自连接；请显式指定 binding",
      });
      continue;
    }
    if (!Object.keys(inferred).length) continue;
    patches.push(
      elementUpdateSchema.parse({
        id: arrow.id,
        ...(inferred.startBinding
          ? { startBinding: { elementId: inferred.startBinding } }
          : {}),
        ...(inferred.endBinding
          ? { endBinding: { elementId: inferred.endBinding } }
          : {}),
      }),
    );
    for (const [endpoint, targetId] of Object.entries(inferred))
      bindings.push({
        elementId: arrow.id,
        endpoint: endpoint as Endpoint,
        targetId,
      });
  }
  try {
    const result = patches.length
      ? updateDrawingElements(elements, patches).elements
      : [...elements];
    return {
      elements: result,
      bindings,
      warnings,
      complete,
      checkedEndpoints,
      checkedPoints,
      comparisons,
      maxDistance,
    };
  } catch {
    warn({
      code: "INVALID_AUTO_BIND_GEOMETRY",
      message:
        "原生场景无法安全应用自动绑定，已保留原场景和新增图元；请显式指定 binding",
    });
    return {
      elements: [...elements],
      bindings: [],
      warnings,
      complete: false,
      checkedEndpoints,
      checkedPoints,
      comparisons,
      maxDistance,
    };
  }
};
