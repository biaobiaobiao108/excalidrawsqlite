import {
  FONT_FAMILY,
  getFontString,
  getSizeFromPoints,
  rescalePoints,
} from "@excalidraw/common";
import { pointFrom } from "@excalidraw/math";
import type { LocalPoint } from "@excalidraw/math";
import {
  newElement,
  newTextElement,
  newLinearElement,
  newArrowElement,
} from "@excalidraw/element/newElement";
import { newElementWith } from "@excalidraw/element/mutateElement";
import { syncInvalidIndices } from "@excalidraw/element/fractionalIndex";
import { Scene } from "@excalidraw/element/Scene";
import {
  calculateFixedPointForNonElbowArrowBinding,
  normalizeFixedPoint,
  updateBoundElements,
  updateBoundPoint,
  getGlobalFixedPointForBindableElement,
} from "@excalidraw/element/binding";
import {
  isArrowElement,
  isBindableElement,
} from "@excalidraw/element/typeChecks";
import { setCustomTextMetricsProvider } from "@excalidraw/element/textMeasurements";
import {
  computeBoundTextPosition,
  getBoundTextMaxWidth,
} from "@excalidraw/element/textElement";
import { wrapText } from "@excalidraw/element/textWrapping";
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
  ExcalidrawTextElementWithContainer,
  ElementsMap,
  FontFamilyValues,
  NonDeletedSceneElementsMap,
  NonDeleted,
} from "@excalidraw/element/types";
import { HttpError } from "./errors";
import { estimateTextLineWidth } from "./mcp-text-metrics";
import {
  coordinate,
  isAutomaticArrow,
  style,
  validateLinear,
  type Spec,
  type Update,
} from "./mcp-drawing-schema";

export {
  colorSchema,
  drawingElementSchema,
  elementUpdateSchema,
} from "./mcp-drawing-schema";
export {
  compactElement,
  inputDrawingElements,
  removeDrawingElements,
} from "./mcp-drawing-serialize";
setCustomTextMetricsProvider({
  getLineWidth(text, fontString) {
    const size = Number.parseFloat(fontString) || 20;
    return estimateTextLineWidth(text, size);
  },
});
const fontId = (font: unknown): FontFamilyValues =>
  typeof font === "number"
    ? (font as FontFamilyValues)
    : (({ Excalifont: 5, system: 13, WenKai: 11 }[String(font)] ||
        5) as FontFamilyValues);
const props = (spec: Partial<Spec> | Update): Record<string, unknown> => ({
  ...(spec.groupIds !== undefined
    ? { groupIds: [...spec.groupIds] }
    : spec.groupId !== undefined
      ? { groupIds: spec.groupId === null ? [] : [spec.groupId] }
      : {}),
  ...Object.fromEntries(
    Object.keys(style)
      .filter(
        (key) =>
          !["rotation", "roundness"].includes(key) &&
          (spec as Record<string, unknown>)[key] !== undefined,
      )
      .map((key) => [key, (spec as Record<string, unknown>)[key]]),
  ),
  ...(spec.rotation === undefined
    ? {}
    : { angle: (spec.rotation * Math.PI) / 180 }),
  ...(spec.roundness === undefined
    ? {}
    : {
        roundness:
          typeof spec.roundness === "number"
            ? spec.roundness
              ? { type: 3 as const, value: spec.roundness }
              : null
            : spec.roundness,
      }),
});
const geometry = (absolute: readonly (readonly number[])[]) => {
  const x = absolute[0][0],
    y = absolute[0][1];
  return {
    x,
    y,
    points: absolute.map((p) => pointFrom<LocalPoint>(p[0] - x, p[1] - y)),
    width:
      Math.max(...absolute.map((p) => p[0])) -
      Math.min(...absolute.map((p) => p[0])),
    height:
      Math.max(...absolute.map((p) => p[1])) -
      Math.min(...absolute.map((p) => p[1])),
  };
};
const layoutLabel = (
  shape: ExcalidrawElement,
  label: ExcalidrawTextElement,
) => {
  const text = wrapText(
    label.originalText,
    getFontString(label),
    getBoundTextMaxWidth(shape, label),
  );
  const measured = newTextElement({
    ...label,
    x: 0,
    y: 0,
    text,
    originalText: label.originalText,
  });
  const position = computeBoundTextPosition(
    shape,
    measured as ExcalidrawTextElementWithContainer,
    new Map() as ElementsMap,
  );
  return { ...measured, ...position, angle: shape.angle };
};
const layoutFreeText = (
  element: ExcalidrawTextElement,
  width?: number,
  autoResize = width === undefined ? element.autoResize : false,
) => {
  const fixedWidth = width ?? element.width;
  const text = autoResize
    ? element.originalText
    : wrapText(element.originalText, getFontString(element), fixedWidth);
  const measured = newTextElement({ ...element, x: 0, y: 0, text, autoResize });
  return {
    ...measured,
    x: element.x,
    y: element.y,
    width: autoResize ? measured.width : fixedWidth,
  };
};
/** Uses the same bounded server estimator as MCP text creation, not browser font metrics. */
export const measureDrawingText = (spec: {
  text: string;
  fontSize?: number;
  fontFamily?: string | number;
  width?: number;
}) => {
  const element = layoutFreeText(
    newTextElement({
      x: 0,
      y: 0,
      text: spec.text,
      fontSize: spec.fontSize,
      fontFamily: fontId(spec.fontFamily),
    }),
    spec.width,
  );
  return {
    text: element.text,
    originalText: element.originalText,
    width: element.width,
    height: element.height,
    fontSize: element.fontSize,
    fontFamily: element.fontFamily,
    lineHeight: element.lineHeight,
    lineHeightPx: element.fontSize * element.lineHeight,
    lineCount: element.text.split("\n").length,
    estimated: true as const,
    measurement: "server-estimate" as const,
    note: "与 MCP 创建文字使用同一估算器；CJK 宽字符、全角形式与 emoji 字素簇约 1em，Latin 及半角字符约 0.58em，组合附加符号不额外占宽。常用歧义标点在含中日韩文的整行按 1em，其余按 0.58em。lineHeight 为原生行高倍率，lineHeightPx 为像素行高；实际字体、字形与回退字体可能不同。",
  };
};
const linearGeometry = (value: {
  points?: [number, number][];
  x?: number;
  y?: number;
}) => {
  const points = value.points!;
  const [offsetX, offsetY] = points[0];
  return {
    x: value.x! + offsetX,
    y: value.y! + offsetY,
    points: points.map(([x, y]) =>
      pointFrom<LocalPoint>(x - offsetX, y - offsetY),
    ),
    width:
      Math.max(...points.map(([x]) => x)) - Math.min(...points.map(([x]) => x)),
    height:
      Math.max(...points.map(([, y]) => y)) -
      Math.min(...points.map(([, y]) => y)),
  };
};

export const createDrawingElements = (spec: Spec): ExcalidrawElement[] => {
  if (
    (spec.type === "rectangle" ||
      spec.type === "ellipse" ||
      spec.type === "diamond") &&
    spec.labelStyle?.rotation !== undefined &&
    Math.abs(spec.labelStyle.rotation - (spec.rotation ?? 0)) > 1e-10
  )
    throw new HttpError(
      400,
      "INVALID_ELEMENT_UPDATE",
      "绑定文字随形状旋转，labelStyle.rotation 必须与形状 rotation 相同",
    );
  const base = { ...props(spec), ...(spec.id ? { id: spec.id } : {}) };
  if (spec.type === "line" || spec.type === "arrow") {
    const opts = {
      ...base,
      ...(isAutomaticArrow(spec)
        ? geometry([
            [0, 0],
            [1, 1],
          ])
        : linearGeometry(spec)),
    };
    return [
      spec.type === "line"
        ? newLinearElement({ type: "line", ...opts })
        : newArrowElement({
            type: "arrow",
            ...opts,
            startArrowhead: spec.startArrowhead ?? null,
            endArrowhead:
              spec.endArrowhead === undefined ? "arrow" : spec.endArrowhead,
          }),
    ];
  }
  if (spec.type === "text")
    return [
      {
        ...layoutFreeText(
          newTextElement({
            ...base,
            x: spec.x,
            y: spec.y,
            text: spec.text,
            fontSize: spec.fontSize,
            fontFamily: fontId(spec.fontFamily),
            textAlign: spec.textAlign,
          }),
          spec.width,
          spec.autoResize ?? spec.width === undefined,
        ),
        // The writable API consistently uses top-left coordinates, including
        // centered/right-aligned text, just as updateDrawingElements does.
        x: spec.x,
        y: spec.y,
      },
    ];
  const shape = newElement({
    ...base,
    type: spec.type,
    x: spec.x,
    y: spec.y,
    width: spec.width,
    height: spec.height,
  });
  if (!spec.text) return [shape];
  const label = layoutLabel(
    shape,
    newTextElement({
      ...props(spec),
      ...props(spec.labelStyle || {}),
      ...(spec.labelId ? { id: spec.labelId } : {}),
      x: 0,
      y: 0,
      text: spec.text,
      fontSize: spec.labelStyle?.fontSize ?? spec.fontSize,
      fontFamily: fontId(spec.labelStyle?.fontFamily ?? spec.fontFamily),
      textAlign: spec.labelStyle?.textAlign ?? spec.textAlign ?? "center",
      verticalAlign: "middle",
      containerId: shape.id,
    }),
  );
  return [{ ...shape, boundElements: [{ id: label.id, type: "text" }] }, label];
};
const connect = (
  elements: ExcalidrawElement[],
  requests: readonly (Spec | Update)[],
  autoPlace = false,
) => {
  const map = new Map(elements.map((e) => [e.id, e]));
  for (const request of requests) {
    const arrow = map.get(request.id!);
    if (autoPlace && isAutomaticArrow(request)) {
      const endpoints = (["startBinding", "endBinding"] as const).map((key) => {
        const value = (request as Update)[key];
        const target = value && map.get(value.elementId);
        if (!value || !isBindableElement(target) || target.isDeleted)
          throw new HttpError(
            400,
            "INVALID_BINDING",
            `绑定目标不存在或不可绑定：${value?.elementId ?? key}`,
          );
        return {
          target,
          value,
          point: getGlobalFixedPointForBindableElement(
            value.fixedPoint ?? [0.5, 0.5],
            target,
            map as ElementsMap,
          ),
        };
      });
      if (
        endpoints[0].target.id === endpoints[1].target.id ||
        (endpoints[0].point[0] === endpoints[1].point[0] &&
          endpoints[0].point[1] === endpoints[1].point[1])
      )
        throw new HttpError(
          400,
          "AUTO_ARROW_GEOMETRY_REQUIRED",
          "自连接或同中心目标需要显式 points 指定路径",
        );
      if (!arrow || !isArrowElement(arrow))
        throw new HttpError(400, "INVALID_BINDING", "自动连接仅支持箭头");
      const automaticArrow = newElementWith(arrow, {
        ...geometry(endpoints.map(({ point }) => point)),
        startBinding: {
          elementId: endpoints[0].target.id,
          fixedPoint: normalizeFixedPoint(
            endpoints[0].value.fixedPoint ?? [0.5, 0.5],
          ),
          mode: endpoints[0].value.mode ?? "orbit",
        },
        endBinding: {
          elementId: endpoints[1].target.id,
          fixedPoint: normalizeFixedPoint(
            endpoints[1].value.fixedPoint ?? [0.5, 0.5],
          ),
          mode: endpoints[1].value.mode ?? "orbit",
        },
      });
      map.set(automaticArrow.id, automaticArrow);
      const absolute = endpoints.map(({ target }, index) => {
        const key = index === 0 ? "startBinding" : "endBinding";
        const point = updateBoundPoint(
          automaticArrow as NonDeleted<typeof automaticArrow>,
          key,
          automaticArrow[key],
          target,
          map as ElementsMap,
        );
        return point
          ? [automaticArrow.x + point[0], automaticArrow.y + point[1]]
          : endpoints[index].point;
      });
      if (
        absolute[0][0] === absolute[1][0] &&
        absolute[0][1] === absolute[1][1]
      )
        throw new HttpError(
          400,
          "AUTO_ARROW_GEOMETRY_REQUIRED",
          "自动连接端点重合，请显式 points 指定路径",
        );
      if (
        absolute.some((point) =>
          point.some((value) => !coordinate.safeParse(value).success),
        )
      )
        throw new HttpError(
          400,
          "AUTO_ARROW_GEOMETRY_REQUIRED",
          "自动连接端点超出画布坐标范围",
        );
      const placedArrow = newElementWith(automaticArrow, geometry(absolute));
      map.set(placedArrow.id, placedArrow);
      continue;
    }
    for (const key of ["startBinding", "endBinding"] as const) {
      if (!(key in request)) continue;
      if (!arrow || !isArrowElement(arrow))
        throw new HttpError(
          400,
          "INVALID_ELEMENT_UPDATE",
          "只有箭头支持 binding",
        );
      const value = (request as Update)[key];
      if (!value) {
        map.set(
          arrow.id,
          newElementWith(map.get(arrow.id)! as typeof arrow, { [key]: null }),
        );
        continue;
      }
      const target = map.get(value.elementId);
      if (!isBindableElement(target) || target.isDeleted)
        throw new HttpError(
          400,
          "INVALID_BINDING",
          `绑定目标不存在或不可绑定：${value.elementId}`,
        );
      const hasExplicitPoints =
        "points" in request || "x" in request || "y" in request;
      const fixedPoint: [number, number] = value.fixedPoint
        ? normalizeFixedPoint(value.fixedPoint)
        : hasExplicitPoints
          ? calculateFixedPointForNonElbowArrowBinding(
              arrow as NonDeleted<typeof arrow>,
              target as NonDeleted<typeof target>,
              key === "startBinding" ? "start" : "end",
              map as unknown as NonDeletedSceneElementsMap,
            ).fixedPoint
          : [0.5, 0.5];
      map.set(
        arrow.id,
        newElementWith(
          map.get(arrow.id)! as typeof arrow,
          {
            [key]: {
              elementId: target.id,
              fixedPoint,
              mode: value.mode || "orbit",
            },
          } as never,
        ),
      );
    }
    if (
      arrow &&
      isArrowElement(arrow) &&
      ("startBinding" in request || "endBinding" in request)
    ) {
      const hasExplicitPoints =
        "points" in request || "x" in request || "y" in request;
      if (!hasExplicitPoints) {
        const currentArrow = map.get(arrow.id)! as typeof arrow;
        const startId = currentArrow.startBinding?.elementId;
        const endId = currentArrow.endBinding?.elementId;
        const startTarget = startId ? map.get(startId) : null;
        const endTarget = endId ? map.get(endId) : null;
        const currStart: [number, number] = [
          currentArrow.x + currentArrow.points[0][0],
          currentArrow.y + currentArrow.points[0][1],
        ];
        const currEnd: [number, number] = [
          currentArrow.x +
            currentArrow.points[currentArrow.points.length - 1][0],
          currentArrow.y +
            currentArrow.points[currentArrow.points.length - 1][1],
        ];
        const isNearTarget = (
          point: [number, number],
          target: ExcalidrawElement,
        ) => {
          const dx = Math.max(
            target.x - point[0],
            0,
            point[0] - (target.x + target.width),
          );
          const dy = Math.max(
            target.y - point[1],
            0,
            point[1] - (target.y + target.height),
          );
          return Math.hypot(dx, dy) <= 24;
        };
        const needRebindStart =
          "startBinding" in request &&
          startTarget &&
          isBindableElement(startTarget) &&
          !isNearTarget(currStart, startTarget);
        const needRebindEnd =
          "endBinding" in request &&
          endTarget &&
          isBindableElement(endTarget) &&
          !isNearTarget(currEnd, endTarget);

        if (needRebindStart || needRebindEnd) {
          const reqStart =
            "startBinding" in request
              ? (request as Update).startBinding
              : undefined;
          const reqEnd =
            "endBinding" in request
              ? (request as Update).endBinding
              : undefined;
          const startPoint: [number, number] =
            needRebindStart && startTarget && isBindableElement(startTarget)
              ? getGlobalFixedPointForBindableElement(
                  reqStart?.fixedPoint ?? [0.5, 0.5],
                  startTarget,
                  map as ElementsMap,
                )
              : currStart;
          const endPoint: [number, number] =
            needRebindEnd && endTarget && isBindableElement(endTarget)
              ? getGlobalFixedPointForBindableElement(
                  reqEnd?.fixedPoint ?? [0.5, 0.5],
                  endTarget,
                  map as ElementsMap,
                )
              : currEnd;
          if (startPoint[0] !== endPoint[0] || startPoint[1] !== endPoint[1]) {
            const placed = newElementWith(currentArrow, {
              ...geometry([startPoint, endPoint]),
              startBinding: currentArrow.startBinding
                ? {
                    ...currentArrow.startBinding,
                    fixedPoint: reqStart
                      ? reqStart.fixedPoint
                        ? normalizeFixedPoint(reqStart.fixedPoint)
                        : [0.5, 0.5]
                      : currentArrow.startBinding.fixedPoint,
                  }
                : null,
              endBinding: currentArrow.endBinding
                ? {
                    ...currentArrow.endBinding,
                    fixedPoint: reqEnd
                      ? reqEnd.fixedPoint
                        ? normalizeFixedPoint(reqEnd.fixedPoint)
                        : [0.5, 0.5]
                      : currentArrow.endBinding.fixedPoint,
                  }
                : null,
            });
            map.set(placed.id, placed);
            const adjustedStart =
              startTarget && isBindableElement(startTarget)
                ? updateBoundPoint(
                    placed as NonDeleted<typeof placed>,
                    "startBinding",
                    placed.startBinding,
                    startTarget,
                    map as ElementsMap,
                  )
                : null;
            const adjustedEnd =
              endTarget && isBindableElement(endTarget)
                ? updateBoundPoint(
                    placed as NonDeleted<typeof placed>,
                    "endBinding",
                    placed.endBinding,
                    endTarget,
                    map as ElementsMap,
                  )
                : null;
            const finalStart: [number, number] = adjustedStart
              ? [placed.x + adjustedStart[0], placed.y + adjustedStart[1]]
              : startPoint;
            const finalEnd: [number, number] = adjustedEnd
              ? [placed.x + adjustedEnd[0], placed.y + adjustedEnd[1]]
              : endPoint;
            if (
              finalStart[0] !== finalEnd[0] ||
              finalStart[1] !== finalEnd[1]
            ) {
              let finalPlaced = newElementWith(
                placed,
                geometry([finalStart, finalEnd]),
              );
              const startBinding = finalPlaced.startBinding;
              const endBinding = finalPlaced.endBinding;
              let nextStartBinding = startBinding;
              let nextEndBinding = endBinding;
              if (
                startBinding &&
                startTarget &&
                isBindableElement(startTarget) &&
                (!reqStart || !reqStart.fixedPoint)
              ) {
                nextStartBinding = {
                  ...startBinding,
                  fixedPoint: calculateFixedPointForNonElbowArrowBinding(
                    finalPlaced as NonDeleted<typeof finalPlaced>,
                    startTarget as NonDeleted<typeof startTarget>,
                    "start",
                    map as unknown as NonDeletedSceneElementsMap,
                  ).fixedPoint,
                };
              }
              if (
                endBinding &&
                endTarget &&
                isBindableElement(endTarget) &&
                (!reqEnd || !reqEnd.fixedPoint)
              ) {
                nextEndBinding = {
                  ...endBinding,
                  fixedPoint: calculateFixedPointForNonElbowArrowBinding(
                    finalPlaced as NonDeleted<typeof finalPlaced>,
                    endTarget as NonDeleted<typeof endTarget>,
                    "end",
                    map as unknown as NonDeletedSceneElementsMap,
                  ).fixedPoint,
                };
              }
              if (
                nextStartBinding !== startBinding ||
                nextEndBinding !== endBinding
              ) {
                finalPlaced = newElementWith(finalPlaced, {
                  startBinding: nextStartBinding,
                  endBinding: nextEndBinding,
                } as never);
              }
              map.set(placed.id, finalPlaced);
            }
          }
        }
      }
    }
  }
  // Index arrows by the element they bind to in one pass. Rescanning every
  // arrow for every element made this quadratic on large boards, and it runs on
  // every create/update.
  const arrowIdsByTarget = new Map<string, string[]>();
  for (const arrow of map.values()) {
    if (arrow.type !== "arrow") {
      continue;
    }
    const targets = new Set<string>();
    if (arrow.startBinding?.elementId) {
      targets.add(arrow.startBinding.elementId);
    }
    if (arrow.endBinding?.elementId) {
      targets.add(arrow.endBinding.elementId);
    }
    for (const targetId of targets) {
      const arrowIds = arrowIdsByTarget.get(targetId);
      if (arrowIds) {
        arrowIds.push(arrow.id);
      } else {
        arrowIdsByTarget.set(targetId, [arrow.id]);
      }
    }
  }
  for (const element of map.values()) {
    const bound = (element.boundElements || []).filter(
      (b) => b.type !== "arrow",
    );
    for (const arrowId of arrowIdsByTarget.get(element.id) || []) {
      bound.push({ type: "arrow", id: arrowId });
    }
    if (JSON.stringify(bound) !== JSON.stringify(element.boundElements || []))
      map.set(
        element.id,
        newElementWith(element, { boundElements: bound.length ? bound : null }),
      );
  }
  return elements.map((e) => map.get(e.id)!);
};
export const createDrawingBatch = (
  specs: readonly Spec[],
  current: readonly ExcalidrawElement[] = [],
) => {
  if (!specs.length) return { elements: [...current], created: [] };
  const ids = new Set(current.map((e) => e.id));
  const created: ExcalidrawElement[] = [],
    requests: Spec[] = [];
  for (const spec of specs) {
    const group = createDrawingElements(spec);
    for (const e of group) {
      if (ids.has(e.id))
        throw new HttpError(
          400,
          "DUPLICATE_ELEMENT_ID",
          `图元 ID 重复：${e.id}`,
        );
      ids.add(e.id);
      created.push(e);
    }
    requests.push({ ...spec, id: group[0].id });
  }
  const elements = syncInvalidIndices(
      connect([...current, ...created], requests, true),
    ),
    createdIds = new Set(created.map((e) => e.id));
  return { elements, created: elements.filter((e) => createdIds.has(e.id)) };
};
export const updateDrawingElements = (
  current: readonly ExcalidrawElement[],
  updates: readonly Update[],
) => {
  if (!updates.length) return { elements: [...current], updatedCount: 0 };
  const map = new Map(current.map((e) => [e.id, e]));
  const seen = new Set<string>();
  const applied: Update[] = [];
  for (const input of updates) {
    let patch = input;
    if (seen.has(patch.id))
      throw new HttpError(
        400,
        "DUPLICATE_ELEMENT_ID",
        `重复修改图元：${patch.id}`,
      );
    seen.add(patch.id);
    const element = map.get(patch.id);
    if (!element)
      throw new HttpError(404, "ELEMENT_NOT_FOUND", `图元不存在：${patch.id}`);
    if (patch.type !== undefined && patch.type !== element.type)
      throw new HttpError(
        400,
        "INVALID_ELEMENT_UPDATE",
        `不支持类型转换：${element.type} → ${patch.type}`,
      );
    if (patch.dx !== undefined || patch.dy !== undefined) {
      if (element.type === "text" && element.containerId)
        throw new HttpError(
          400,
          "INVALID_ELEMENT_UPDATE",
          "绑定文字不能独立平移，请移动所属容器",
        );
      const { dx, dy, ...absolute } = patch;
      const x = dx === undefined ? patch.x : element.x + dx;
      const y = dy === undefined ? patch.y : element.y + dy;
      if (
        (x !== undefined && !coordinate.safeParse(x).success) ||
        (y !== undefined && !coordinate.safeParse(y).success)
      )
        throw new HttpError(
          400,
          "INVALID_ELEMENT_UPDATE",
          "平移后的坐标超出画布范围",
        );
      patch = {
        ...absolute,
        ...(x === undefined ? {} : { x }),
        ...(y === undefined ? {} : { y }),
      };
    }
    const labelContainer =
      element.type === "text" && element.containerId
        ? map.get(element.containerId)
        : undefined;
    const isShapeLabel =
      ["rectangle", "ellipse", "diamond"].includes(element.type) ||
      (!!labelContainer &&
        ["rectangle", "ellipse", "diamond"].includes(labelContainer.type));
    const shape = ["rectangle", "ellipse", "diamond"].includes(element.type);
    if (
      patch.autoResize !== undefined &&
      (element.type !== "text" || element.containerId)
    )
      throw new HttpError(
        400,
        "INVALID_ELEMENT_UPDATE",
        "autoResize 仅独立文字使用；绑定标签由所属形状控制尺寸",
      );
    if (element.type === "text") {
      if (patch.height !== undefined)
        throw new HttpError(
          400,
          "INVALID_ELEMENT_UPDATE",
          "文字 height 由内容自动计算；请通过 width 控制换行或 fontSize 调整字号",
        );
      if (element.containerId && patch.width !== undefined)
        throw new HttpError(
          400,
          "INVALID_ELEMENT_UPDATE",
          "绑定文字宽度由所属形状控制，请修改形状 width",
        );
    }
    const existingLabelId = element.boundElements?.find(
      (b) => b.type === "text",
    )?.id;
    const existingLabel = existingLabelId
      ? map.get(existingLabelId)
      : undefined;
    if (patch.labelId !== undefined || patch.labelStyle !== undefined) {
      if (!shape)
        throw new HttpError(
          400,
          "INVALID_ELEMENT_UPDATE",
          "只有形状支持 labelId 和 labelStyle；独立文字请直接修改文字字段",
        );
      if (patch.text === "" || (existingLabel?.type !== "text" && !patch.text))
        throw new HttpError(
          400,
          "INVALID_ELEMENT_UPDATE",
          "labelId 和 labelStyle 需要已有标签或同时提供非空 text",
        );
      if (
        existingLabelId &&
        patch.labelId !== undefined &&
        patch.labelId !== existingLabelId
      )
        throw new HttpError(
          400,
          "INVALID_ELEMENT_UPDATE",
          "已有标签不能重命名 labelId，请保留原 ID",
        );
      if (!existingLabelId && patch.labelId && map.has(patch.labelId))
        throw new HttpError(
          400,
          "DUPLICATE_ELEMENT_ID",
          `标签 ID 已存在：${patch.labelId}`,
        );
      if (
        patch.labelStyle?.rotation !== undefined &&
        Math.abs(
          patch.labelStyle.rotation -
            (patch.rotation ?? (element.angle * 180) / Math.PI),
        ) > 1e-10
      )
        throw new HttpError(
          400,
          "INVALID_ELEMENT_UPDATE",
          "绑定文字随形状旋转，labelStyle.rotation 必须与更新后形状 rotation 相同",
        );
    }
    if (isShapeLabel && patch.text !== undefined && patch.text.length > 2_000)
      throw new HttpError(
        400,
        "INVALID_ELEMENT_UPDATE",
        `形状标签最多 2000 字符，图元 ${patch.id} 收到 ${patch.text.length} 字符`,
      );
    const linear = element.type === "arrow" || element.type === "line";
    if (linear && (patch.width !== undefined || patch.height !== undefined)) {
      if (patch.points !== undefined)
        throw new HttpError(
          400,
          "INVALID_ELEMENT_UPDATE",
          "线性图元的 width/height 不能与 points 同时提供，请只指定一种尺寸修改方式",
        );
      if (
        (isArrowElement(element) &&
          (element.elbowed ||
            (patch.startBinding === undefined
              ? element.startBinding
              : patch.startBinding) ||
            (patch.endBinding === undefined
              ? element.endBinding
              : patch.endBinding))) ||
        element.boundElements?.some((bound) => bound.type === "text")
      )
        throw new HttpError(
          400,
          "INVALID_ELEMENT_UPDATE",
          "带绑定、标签或肘线的线性图元不能通过 width/height 缩放，请修改 points 或所属节点",
        );
      const size = getSizeFromPoints(element.points);
      if (
        (patch.width !== undefined && size.width === 0) ||
        (patch.height !== undefined && size.height === 0)
      )
        throw new HttpError(
          400,
          "INVALID_ELEMENT_UPDATE",
          "零尺寸轴无法按比例缩放，请通过 points 指定线性图元的新路径",
        );
      let scaled = element.points;
      if (patch.width !== undefined)
        scaled = rescalePoints(0, patch.width, scaled, false);
      if (patch.height !== undefined)
        scaled = rescalePoints(1, patch.height, scaled, false);
      // Feed resizing through the same origin normalization and coordinate
      // validation as explicit points, keeping stored bounds and paths coherent.
      patch = {
        ...patch,
        x: patch.x ?? element.x,
        y: patch.y ?? element.y,
        points: scaled.map(([x, y]) => [x, y]),
      };
    }
    if (
      linear &&
      patch.points === undefined &&
      (patch.x !== undefined || patch.y !== undefined) &&
      element.points.some(
        ([x, y]) =>
          !coordinate.safeParse((patch.x ?? element.x) + x).success ||
          !coordinate.safeParse((patch.y ?? element.y) + y).success,
      )
    )
      throw new HttpError(
        400,
        "INVALID_ELEMENT_UPDATE",
        "移动后的线性图元点坐标超出画布范围",
      );
    if (!linear && patch.points !== undefined)
      throw new HttpError(
        400,
        "INVALID_ELEMENT_UPDATE",
        "只有直线和箭头支持 points",
      );
    if (
      element.type !== "arrow" &&
      ["startBinding", "endBinding", "startArrowhead", "endArrowhead"].some(
        (key) => key in patch,
      )
    )
      throw new HttpError(
        400,
        "INVALID_ELEMENT_UPDATE",
        element.type === "line"
          ? "line 是固定坐标线段；节点绑定请新建 type:arrow 并传 endArrowhead:null，实现无箭头连线，不支持直接转换已有 line 类型"
          : "只有箭头支持端点绑定或箭头样式；无箭头连接可用 type:arrow、endArrowhead:null",
      );
    const textKeys = ["text", "fontSize", "fontFamily", "textAlign"];
    if (
      element.type !== "text" &&
      !["rectangle", "ellipse", "diamond"].includes(element.type) &&
      textKeys.some((key) => key in patch)
    )
      throw new HttpError(
        400,
        "INVALID_ELEMENT_UPDATE",
        "此图元不支持文字字段",
      );
    const changes: Record<string, unknown> = { ...props(patch) };
    if (element.type === "text" && patch.width !== undefined)
      changes.autoResize = false;
    for (const key of [
      "x",
      "y",
      "width",
      "height",
      "autoResize",
      "startArrowhead",
      "endArrowhead",
    ] as const)
      if (patch[key] !== undefined) changes[key] = patch[key];
    if (linear && patch.points) {
      if (!validateLinear(patch))
        throw new HttpError(
          400,
          "INVALID_ELEMENT_UPDATE",
          "修改 points 时 x/y 原点须成对提供，points 须不同且所有全局点坐标须在允许范围内",
        );
      Object.assign(changes, linearGeometry(patch));
    }
    const labelIdForComparison =
      element.type === "text"
        ? element.id
        : element.boundElements?.find((b) => b.type === "text")?.id;
    const labelForComparison = labelIdForComparison
      ? map.get(labelIdForComparison)
      : undefined;
    const textComparison =
      labelForComparison?.type === "text" ? labelForComparison : undefined;
    const sameGeometry = Object.entries(changes).every(
      ([key, value]) =>
        JSON.stringify((element as unknown as Record<string, unknown>)[key]) ===
        JSON.stringify(value),
    );
    const labelTypography = {
      fontSize: patch.labelStyle?.fontSize ?? patch.fontSize,
      fontFamily: patch.labelStyle?.fontFamily ?? patch.fontFamily,
      textAlign: patch.labelStyle?.textAlign ?? patch.textAlign,
    };
    const sameText =
      (patch.text === undefined ||
        patch.text === (textComparison?.originalText ?? "")) &&
      (labelTypography.fontSize === undefined ||
        labelTypography.fontSize === textComparison?.fontSize) &&
      (labelTypography.fontFamily === undefined ||
        fontId(labelTypography.fontFamily) === textComparison?.fontFamily) &&
      (labelTypography.textAlign === undefined ||
        labelTypography.textAlign === textComparison?.textAlign);
    const nestedLabelChanges = props(patch.labelStyle || {});
    const sameLabelStyle =
      Object.entries(nestedLabelChanges).every(
        ([key, value]) =>
          JSON.stringify(
            (
              textComparison as unknown as Record<string, unknown> | undefined
            )?.[key],
          ) === JSON.stringify(value),
      ) &&
      (patch.labelStyle?.fontSize === undefined ||
        patch.labelStyle.fontSize === textComparison?.fontSize) &&
      (patch.labelStyle?.fontFamily === undefined ||
        fontId(patch.labelStyle.fontFamily) === textComparison?.fontFamily) &&
      (patch.labelStyle?.textAlign === undefined ||
        patch.labelStyle.textAlign === textComparison?.textAlign);
    const sameBindings = (["startBinding", "endBinding"] as const).every(
      (key) => {
        if (!(key in patch)) return true;
        const requested = patch[key];
        const previous = element.type === "arrow" ? element[key] : null;
        if (!requested || !previous) return requested === previous;
        return (
          requested.elementId === previous.elementId &&
          (requested.mode || "orbit") === previous.mode &&
          (requested.fixedPoint === undefined ||
            JSON.stringify(normalizeFixedPoint(requested.fixedPoint)) ===
              JSON.stringify(previous.fixedPoint))
        );
      },
    );
    if (sameGeometry && sameText && sameBindings && sameLabelStyle) continue;
    applied.push(patch);
    let next = newElementWith(element, changes as never);
    if (element.type === "text") {
      const measured = newTextElement({
        ...element,
        ...changes,
        x: 0,
        y: 0,
        text: patch.text ?? element.originalText,
        originalText: patch.text ?? element.originalText,
        fontSize: patch.fontSize ?? element.fontSize,
        fontFamily:
          patch.fontFamily === undefined
            ? element.fontFamily
            : fontId(patch.fontFamily),
        textAlign: patch.textAlign ?? element.textAlign,
      });
      const laidOut =
        isShapeLabel && labelContainer
          ? layoutLabel(labelContainer, measured)
          : {
              ...layoutFreeText(
                measured,
                patch.width ??
                  (!element.autoResize ? element.width : undefined),
                patch.autoResize ??
                  (patch.width === undefined ? element.autoResize : false),
              ),
              x: patch.x ?? element.x,
              y: patch.y ?? element.y,
            };
      // Constructors preserve the source version; apply the new text/layout as
      // an element update so remote Store snapshots observe direct text edits.
      const {
        version: _version,
        versionNonce: _nonce,
        updated: _updated,
        ...textChanges
      } = laidOut;
      next = newElementWith(element, textChanges as never);
    } else if (["rectangle", "ellipse", "diamond"].includes(element.type)) {
      const labelId = element.boundElements?.find((b) => b.type === "text")?.id;
      const existing = labelId ? map.get(labelId) : undefined;
      if (existing?.type === "text" || patch.text) {
        const label =
          existing?.type === "text"
            ? existing
            : newTextElement({
                ...(patch.labelId ? { id: patch.labelId } : {}),
                x: 0,
                y: 0,
                text: patch.text!,
                containerId: element.id,
                textAlign: "center",
                verticalAlign: "middle",
              });
        if (patch.text === "") {
          map.delete(label.id);
          next = newElementWith(next, {
            boundElements:
              next.boundElements?.filter((b) => b.id !== label.id) || null,
          });
        } else {
          const refreshed = newTextElement({
            ...label,
            ...props(patch),
            ...nestedLabelChanges,
            x: 0,
            y: 0,
            text: patch.text ?? label.originalText,
            originalText: patch.text ?? label.originalText,
            fontSize:
              patch.labelStyle?.fontSize ?? patch.fontSize ?? label.fontSize,
            fontFamily:
              (patch.labelStyle?.fontFamily ?? patch.fontFamily) === undefined
                ? label.fontFamily
                : fontId(patch.labelStyle?.fontFamily ?? patch.fontFamily),
            textAlign:
              patch.labelStyle?.textAlign ?? patch.textAlign ?? label.textAlign,
          });
          const laidOut = layoutLabel(next, refreshed);
          // Text constructors retain the source version. Existing labels must
          // advance it for Store/History to adopt remote content and layout,
          // while constructor timestamps alone must not create false changes.
          const labelChanges = Object.fromEntries(
            Object.entries(laidOut).filter(
              ([key, value]) =>
                !["version", "versionNonce", "updated"].includes(key) &&
                JSON.stringify(
                  (label as unknown as Record<string, unknown>)[key],
                ) !== JSON.stringify(value),
            ),
          );
          map.set(
            label.id,
            existing?.type === "text"
              ? newElementWith(label, labelChanges as never)
              : laidOut,
          );
          if (!labelId)
            next = newElementWith(next, {
              boundElements: [
                ...(next.boundElements || []),
                { id: label.id, type: "text" },
              ],
            });
        }
      }
    }
    map.set(next.id, next);
  }
  if (!applied.length) return { elements: [...current], updatedCount: 0 };
  const connected = syncInvalidIndices(connect([...map.values()], applied));
  // Use the same geometric binding update as the editor, on cloned objects so
  // failed MCP requests cannot mutate the fetched scene or its caller's cache.
  const scene = new Scene();
  let elements: ExcalidrawElement[];
  try {
    scene.replaceAllElements(structuredClone(connected), {
      skipValidation: true,
    });
    const nonDeletedMap = scene.getNonDeletedElementsMap();
    const changed = applied
      .map((patch) => nonDeletedMap.get(patch.id))
      .filter((element) => element !== undefined);
    for (const element of changed)
      updateBoundElements(element, scene, { simultaneouslyUpdated: changed });
    elements = [...scene.getElementsIncludingDeleted()];
  } finally {
    scene.destroy();
  }
  return { elements, updatedCount: applied.length };
};
