import { getFontString } from "@excalidraw/common";
import { pointFrom } from "@excalidraw/math";
import type { LocalPoint } from "@excalidraw/math";
import { newTextElement } from "@excalidraw/element/newElement";
import { newElementWith } from "@excalidraw/element/mutateElement";
import {
  calculateFixedPointForNonElbowArrowBinding,
  normalizeFixedPoint,
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
  type Spec,
  type Update,
} from "./mcp-drawing-schema";

setCustomTextMetricsProvider({
  getLineWidth(text, fontString) {
    const size = Number.parseFloat(fontString) || 20;
    return estimateTextLineWidth(text, size);
  },
});

export const fontId = (font: unknown): FontFamilyValues =>
  typeof font === "number"
    ? (font as FontFamilyValues)
    : (({ Excalifont: 5, system: 13, WenKai: 11 }[String(font)] ||
        5) as FontFamilyValues);

export const props = (
  spec: Partial<Spec> | Update,
): Record<string, unknown> => ({
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

export const geometry = (absolute: readonly (readonly number[])[]) => {
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

export const layoutLabel = (
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

export const layoutFreeText = (
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

export const linearGeometry = (value: {
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

export const connect = (
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
