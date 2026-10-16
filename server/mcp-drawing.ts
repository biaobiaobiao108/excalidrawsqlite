import * as z from "zod/v4";
import { FONT_FAMILY, getFontString } from "@excalidraw/common";
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
import { isArrowElement, isBindableElement } from "@excalidraw/element/typeChecks";
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
import { colorSchema } from "./color";
import { estimateTextLineWidth } from "./mcp-text-metrics";
export { colorSchema } from "./color";

const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const dimension = z.number().finite().positive().max(1_000_000);
const idSchema = z.string().min(1).max(128);
const grouping = {
  groupId: idSchema.nullable().optional().describe("原生分组 ID；相同 ID 的图元可整体拖动。null 解除分组；不能与 groupIds 同传"),
  groupIds: z.array(idSchema).max(8).refine((ids) => new Set(ids).size === ids.length, "分组 ID 不得重复").optional().describe("原生嵌套分组，从内到外，最多 8 层；[] 解除分组。通常使用 groupId 即可"),
};
const roundness = z
  .union([
    z.number().finite().min(0).max(1_000),
    z
      .object({
        type: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        value: z.number().finite().min(0).max(1_000).optional(),
      })
      .strict(),
  ])
  .nullable();
const typography = {
  fontSize: z.number().finite().min(1).max(512).optional(),
  fontFamily: z
    .union([
      z.enum(["Excalifont", "system", "WenKai"]),
      z
        .number()
        .int()
        .refine(
          (id) => Object.values(FONT_FAMILY).includes(id as FontFamilyValues),
          "无效字体 ID",
        ),
    ])
    .optional()
    .describe(
      "Excalifont（中文小赖回退）、system 或 WenKai，也接受已有图元的有效字体 ID",
    ),
  textAlign: z.enum(["left", "center", "right"]).optional(),
};
const style = {
  strokeColor: colorSchema.optional(),
  backgroundColor: colorSchema.optional(),
  fillStyle: z.enum(["hachure", "cross-hatch", "solid", "zigzag"]).optional(),
  strokeWidth: z.number().finite().min(0.5).max(100).optional(),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  roughness: z.number().finite().min(0).max(2).optional(),
  opacity: z
    .number()
    .finite()
    .min(0)
    .max(100)
    .optional()
    .describe("透明度百分比 0–100，允许小数"),
  roundness: roundness
    .optional()
    .describe("圆角半径像素；0/null 为尖角，或输入 Excalidraw roundness 对象"),
  rotation: z
    .number()
    .finite()
    .min(-360_000)
    .max(360_000)
    .optional()
    .describe("旋转角度，单位度，默认 0"),
};
const binding = z
  .object({
    elementId: idSchema,
    fixedPoint: z
      .tuple([coordinate, coordinate])
      .optional(),
    mode: z.enum(["orbit", "inside"]).optional(),
  })
  .strict()
  .nullable()
  .describe(
    "仅 arrow 支持绑定，可引用同批新图元；无箭头连接用 type:arrow、endArrowhead:null。fixedPoint 为相对目标的归一化坐标，orbit 端点可以超出 [0,1]，默认根据端点推导；mode 默认 orbit，null 解绑",
  );
const arrowhead = z
  .enum([
    "arrow",
    "bar",
    "triangle",
    "triangle_outline",
    "circle",
    "circle_outline",
    "diamond",
    "diamond_outline",
  ])
  .nullable();
const points = z
  .array(z.tuple([z.number().finite().min(-2_000_000).max(2_000_000), z.number().finite().min(-2_000_000).max(2_000_000)]))
  .min(2)
  .max(1_000)
  .describe(
    "相对于 x/y 原点的坐标，支持多段折线；须同时提供 x 和 y，所有全局点坐标须在允许范围内",
  );
const labelStyleSchema = z.object({ ...typography, ...style }).strict();
const shapeFields = {
  ...grouping,
  id: idSchema.optional().describe("可选稳定 ID，供同批箭头 binding 引用"),
  x: coordinate,
  y: coordinate,
  width: dimension,
  height: dimension,
  text: z.string().max(2_000).optional(),
  labelId: idSchema.optional().describe("绑定文字图元的稳定 ID；复制 input 视图时保留，通常无需指定"),
  labelStyle: labelStyleSchema.optional().describe("绑定文字的独立样式；省略时继承形状样式。文字颜色使用 strokeColor；若形状 strokeColor 与 backgroundColor 相同，继承的文字可能不可见，请显式设置 labelStyle.strokeColor 为与底色对比的颜色"),
  ...typography,
  ...style,
};
const linearFields = {
  ...grouping,
  id: idSchema.optional(),
  x: coordinate.optional().describe("与 y 成对提供，作为相对 points 的原点"),
  y: coordinate.optional().describe("与 x 成对提供，作为相对 points 的原点"),
  points: points.optional(),
  ...style,
};
const validateLinear = (value: Record<string, unknown>) => {
  if (value.x === undefined || value.y === undefined || value.points === undefined) return false;
  const ps = value.points as number[][];
  if (ps.some(([x, y]) => !coordinate.safeParse(x + (value.x as number)).success ||
    !coordinate.safeParse(y + (value.y as number)).success)) return false;
  return ps.some((p) => p[0] !== ps[0][0] || p[1] !== ps[0][1]);
};
const isAutomaticArrow = (value: Record<string, unknown>) => value.type === "arrow" &&
  ["points", "x", "y"].every((key) => value[key] === undefined);
const validateArrow = (value: Record<string, unknown>) => isAutomaticArrow(value)
  ? !!value.startBinding && !!value.endBinding && value.rotation === undefined
  : validateLinear(value);
export const drawingElementSchema = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["rectangle", "ellipse", "diamond"]), ...shapeFields }).strict(),
  z
    .object({
      type: z.literal("text"),
      ...grouping,
      id: idSchema.optional(),
      x: coordinate,
      y: coordinate,
      text: z.string().min(1).max(10_000),
      width: dimension.optional().describe("独立文字的固定换行宽度；省略时按内容自动计算宽度。高度按换行后的内容计算，不传 height"),
      autoResize: z.boolean().optional().describe("默认未传 width 时为 true；传 width 时为 false。true 恢复按内容自动计算宽度，不能同时传 width"),
      ...typography,
      ...style,
    })
    .strict()
    .refine((value) => value.autoResize !== false || value.width !== undefined, "autoResize=false 时必须提供 width")
    .refine((value) => value.autoResize !== true || value.width === undefined, "autoResize=true 时不能同时提供 width"),
  z
    .object({ type: z.literal("line"), ...linearFields })
    .strict()
    .refine(validateLinear, "请同时提供 x/y 原点和不同的相对 points，所有全局点坐标须在允许范围内")
    .describe("固定坐标线段或折线，不绑定节点；需要随节点移动的无箭头连线，请使用 arrow 并传 endArrowhead:null"),
  z
    .object({
      type: z.literal("arrow"),
      ...linearFields,
      startBinding: binding.optional(),
      endBinding: binding.optional(),
      startArrowhead: arrowhead.optional().describe("起点箭头样式，默认 null（无箭头）"),
      endArrowhead: arrowhead.optional().describe("终点箭头样式，默认 arrow；null 为无箭头，仍支持节点绑定和自动连接"),
    })
    .strict()
    .refine(validateArrow, "请同时提供 x/y 原点和不同的相对 points，所有全局点坐标须在允许范围内；也可仅传两端 binding 自动连接（不能同时传 rotation）"),
]).refine((value) => value.groupId === undefined || value.groupIds === undefined, "groupId 与 groupIds 不能同时提供");
export const elementUpdateSchema = z
  .object({
    id: idSchema,
    ...grouping,
    type: z.enum(["rectangle", "ellipse", "diamond", "text", "line", "arrow"]).optional().describe("可直接使用 input 视图的图元作为 updates；必须与现有类型相同，不支持类型转换"),
    x: coordinate.optional().describe("绝对 X；线性图元同时传 points 时，须与 y 成对作为相对点原点"),
    y: coordinate.optional().describe("绝对 Y；线性图元同时传 points 时，须与 x 成对作为相对点原点"),
    dx: coordinate.optional().describe("相对平移 X；不能与 x 或 points 同时传入，绑定文字请移动容器"),
    dy: coordinate.optional().describe("相对平移 Y；不能与 y 或 points 同时传入，绑定文字请移动容器"),
    width: dimension.optional(),
    height: dimension.optional(),
    autoResize: z.boolean().optional().describe("仅独立文字使用；true 恢复自动宽度，false 保持固定宽度。传 width 自动启用固定宽度；文字高度始终由内容计算"),
    text: z.string().max(10_000).optional().describe("形状及其绑定标签最多 2000 字符；独立文字最多 10000 字符，空字符串清除形状标签"),
    labelId: idSchema.optional().describe("仅形状使用；新建标签可指定稳定 ID，已有标签只能传相同 ID，不能重命名"),
    labelStyle: labelStyleSchema.optional().describe("仅形状的绑定文字使用；按字段合并独立样式，不修改形状样式；无标签时须同时提供非空 text。文字颜色使用 strokeColor；与底色同色可能不可见，请显式设置 labelStyle.strokeColor 为与底色对比的颜色"),
    ...typography,
    ...style,
    points: points.optional(),
    startBinding: binding.optional(),
    endBinding: binding.optional(),
    startArrowhead: arrowhead.optional(),
    endArrowhead: arrowhead.optional(),
  })
  .strict()
  .refine((value) => value.groupId === undefined || value.groupIds === undefined, "groupId 与 groupIds 不能同时提供")
  .refine((value) => !(value.dx !== undefined && value.x !== undefined) && !(value.dy !== undefined && value.y !== undefined), "dx 与 x、dy 与 y 不能同时提供")
  .refine((value) => value.dx === undefined && value.dy === undefined || value.points === undefined, "相对平移不能与 points 同时提供")
  .refine((value) => value.points === undefined || validateLinear(value), "修改 points 时 x/y 原点须成对提供，points 须不同且所有全局点坐标须在允许范围内")
  .refine((value) => value.autoResize !== true || value.width === undefined, "autoResize=true 时不能同时提供 width")
  .refine((v) => Object.keys(v).length > 1, "请提供至少一个修改字段");
type Spec = z.infer<typeof drawingElementSchema>;
type Update = z.infer<typeof elementUpdateSchema>;
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
  ...(spec.groupIds !== undefined ? { groupIds: [...spec.groupIds] } : spec.groupId !== undefined ? { groupIds: spec.groupId === null ? [] : [spec.groupId] } : {}),
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
export const measureDrawingText = (spec: { text: string; fontSize?: number; fontFamily?: string | number; width?: number }) => {
  const element = layoutFreeText(newTextElement({ x: 0, y: 0, text: spec.text,
    fontSize: spec.fontSize, fontFamily: fontId(spec.fontFamily) }), spec.width);
  return { text: element.text, originalText: element.originalText, width: element.width,
    height: element.height, fontSize: element.fontSize, fontFamily: element.fontFamily,
    lineHeight: element.lineHeight, lineHeightPx: element.fontSize * element.lineHeight,
    lineCount: element.text.split("\n").length, estimated: true as const,
    measurement: "server-estimate" as const,
    note: "与 MCP 创建文字使用同一估算器；CJK 宽字符、全角形式与 emoji 字素簇约 1em，Latin 及半角字符约 0.58em，组合附加符号不额外占宽。常用歧义标点在含中日韩文的整行按 1em，其余按 0.58em。lineHeight 为原生行高倍率，lineHeightPx 为像素行高；实际字体、字形与回退字体可能不同。" };
};
const linearGeometry = (value: { points?: [number, number][]; x?: number; y?: number }) => {
  const points = value.points!;
  const [offsetX, offsetY] = points[0];
  return {
    x: value.x! + offsetX,
    y: value.y! + offsetY,
    points: points.map(([x, y]) => pointFrom<LocalPoint>(x - offsetX, y - offsetY)),
    width: Math.max(...points.map(([x]) => x)) - Math.min(...points.map(([x]) => x)),
    height: Math.max(...points.map(([, y]) => y)) - Math.min(...points.map(([, y]) => y)),
  };
};

export const createDrawingElements = (spec: Spec): ExcalidrawElement[] => {
  if ((spec.type === "rectangle" || spec.type === "ellipse" || spec.type === "diamond") &&
    spec.labelStyle?.rotation !== undefined && Math.abs(spec.labelStyle.rotation - (spec.rotation ?? 0)) > 1e-10)
    throw new HttpError(400, "INVALID_ELEMENT_UPDATE", "绑定文字随形状旋转，labelStyle.rotation 必须与形状 rotation 相同");
  const base = { ...props(spec), ...(spec.id ? { id: spec.id } : {}) };
  if (spec.type === "line" || spec.type === "arrow") {
    const opts = {
      ...base,
      ...(isAutomaticArrow(spec) ? geometry([[0, 0], [1, 1]]) : linearGeometry(spec)),
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
        ...layoutFreeText(newTextElement({
          ...base,
          x: spec.x,
          y: spec.y,
          text: spec.text,
          fontSize: spec.fontSize,
          fontFamily: fontId(spec.fontFamily),
          textAlign: spec.textAlign,
        }), spec.width, spec.autoResize ?? (spec.width === undefined)),
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
          throw new HttpError(400, "INVALID_BINDING", `绑定目标不存在或不可绑定：${value?.elementId ?? key}`);
        return { target, value, point: getGlobalFixedPointForBindableElement(value.fixedPoint ?? [0.5, 0.5], target, map as ElementsMap) };
      });
      if (endpoints[0].target.id === endpoints[1].target.id ||
          endpoints[0].point[0] === endpoints[1].point[0] && endpoints[0].point[1] === endpoints[1].point[1])
        throw new HttpError(400, "AUTO_ARROW_GEOMETRY_REQUIRED", "自连接或同中心目标需要显式 points 指定路径");
      if (!arrow || !isArrowElement(arrow)) throw new HttpError(400, "INVALID_BINDING", "自动连接仅支持箭头");
      const automaticArrow = newElementWith(arrow, { ...geometry(endpoints.map(({ point }) => point)),
        startBinding: { elementId: endpoints[0].target.id, fixedPoint: normalizeFixedPoint(endpoints[0].value.fixedPoint ?? [0.5, 0.5]), mode: endpoints[0].value.mode ?? "orbit" },
        endBinding: { elementId: endpoints[1].target.id, fixedPoint: normalizeFixedPoint(endpoints[1].value.fixedPoint ?? [0.5, 0.5]), mode: endpoints[1].value.mode ?? "orbit" },
      });
      map.set(automaticArrow.id, automaticArrow);
      const absolute = endpoints.map(({ target }, index) => {
        const key = index === 0 ? "startBinding" : "endBinding";
        const point = updateBoundPoint(automaticArrow as NonDeleted<typeof automaticArrow>, key,
          automaticArrow[key], target, map as ElementsMap);
        return point ? [automaticArrow.x + point[0], automaticArrow.y + point[1]] : endpoints[index].point;
      });
      if (absolute[0][0] === absolute[1][0] && absolute[0][1] === absolute[1][1])
        throw new HttpError(400, "AUTO_ARROW_GEOMETRY_REQUIRED", "自动连接端点重合，请显式 points 指定路径");
      if (absolute.some((point) => point.some((value) => !coordinate.safeParse(value).success)))
        throw new HttpError(400, "AUTO_ARROW_GEOMETRY_REQUIRED", "自动连接端点超出画布坐标范围");
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
      const fixedPoint = value.fixedPoint
        ? normalizeFixedPoint(value.fixedPoint)
        : calculateFixedPointForNonElbowArrowBinding(
            arrow as NonDeleted<typeof arrow>,
            target as NonDeleted<typeof target>,
            key === "startBinding" ? "start" : "end",
            map as unknown as NonDeletedSceneElementsMap,
          ).fixedPoint;
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
  }
  for (const element of map.values()) {
    const bound = (element.boundElements || []).filter(
      (b) => b.type !== "arrow",
    );
    for (const arrow of map.values())
      if (
        arrow.type === "arrow" &&
        (arrow.startBinding?.elementId === element.id ||
          arrow.endBinding?.elementId === element.id)
      )
        bound.push({ type: "arrow", id: arrow.id });
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
      throw new HttpError(400, "INVALID_ELEMENT_UPDATE", `不支持类型转换：${element.type} → ${patch.type}`);
    if (patch.dx !== undefined || patch.dy !== undefined) {
      if (element.type === "text" && element.containerId)
        throw new HttpError(400, "INVALID_ELEMENT_UPDATE", "绑定文字不能独立平移，请移动所属容器");
      const { dx, dy, ...absolute } = patch;
      const x = dx === undefined ? patch.x : element.x + dx;
      const y = dy === undefined ? patch.y : element.y + dy;
      if (x !== undefined && !coordinate.safeParse(x).success || y !== undefined && !coordinate.safeParse(y).success)
        throw new HttpError(400, "INVALID_ELEMENT_UPDATE", "平移后的坐标超出画布范围");
      patch = { ...absolute, ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }) };
    }
    const labelContainer = element.type === "text" && element.containerId
      ? map.get(element.containerId)
      : undefined;
    const isShapeLabel = ["rectangle", "ellipse", "diamond"].includes(element.type) ||
      !!labelContainer && ["rectangle", "ellipse", "diamond"].includes(labelContainer.type);
    const shape = ["rectangle", "ellipse", "diamond"].includes(element.type);
    if (patch.autoResize !== undefined && (element.type !== "text" || element.containerId))
      throw new HttpError(400, "INVALID_ELEMENT_UPDATE", "autoResize 仅独立文字使用；绑定标签由所属形状控制尺寸");
    if (element.type === "text") {
      if (patch.height !== undefined)
        throw new HttpError(400, "INVALID_ELEMENT_UPDATE", "文字 height 由内容自动计算；请通过 width 控制换行或 fontSize 调整字号");
      if (element.containerId && patch.width !== undefined)
        throw new HttpError(400, "INVALID_ELEMENT_UPDATE", "绑定文字宽度由所属形状控制，请修改形状 width");
    }
    const existingLabelId = element.boundElements?.find((b) => b.type === "text")?.id;
    const existingLabel = existingLabelId ? map.get(existingLabelId) : undefined;
    if (patch.labelId !== undefined || patch.labelStyle !== undefined) {
      if (!shape)
        throw new HttpError(400, "INVALID_ELEMENT_UPDATE", "只有形状支持 labelId 和 labelStyle；独立文字请直接修改文字字段");
      if (patch.text === "" || (existingLabel?.type !== "text" && !patch.text))
        throw new HttpError(400, "INVALID_ELEMENT_UPDATE", "labelId 和 labelStyle 需要已有标签或同时提供非空 text");
      if (existingLabelId && patch.labelId !== undefined && patch.labelId !== existingLabelId)
        throw new HttpError(400, "INVALID_ELEMENT_UPDATE", "已有标签不能重命名 labelId，请保留原 ID");
      if (!existingLabelId && patch.labelId && map.has(patch.labelId))
        throw new HttpError(400, "DUPLICATE_ELEMENT_ID", `标签 ID 已存在：${patch.labelId}`);
      if (patch.labelStyle?.rotation !== undefined &&
        Math.abs(patch.labelStyle.rotation - (patch.rotation ?? element.angle * 180 / Math.PI)) > 1e-10)
        throw new HttpError(400, "INVALID_ELEMENT_UPDATE", "绑定文字随形状旋转，labelStyle.rotation 必须与更新后形状 rotation 相同");
    }
    if (isShapeLabel && patch.text !== undefined && patch.text.length > 2_000)
      throw new HttpError(
        400,
        "INVALID_ELEMENT_UPDATE",
        `形状标签最多 2000 字符，图元 ${patch.id} 收到 ${patch.text.length} 字符`,
      );
    const linear = element.type === "arrow" || element.type === "line";
    if (linear && patch.points === undefined && (patch.x !== undefined || patch.y !== undefined) &&
      element.points.some(([x, y]) => !coordinate.safeParse((patch.x ?? element.x) + x).success ||
        !coordinate.safeParse((patch.y ?? element.y) + y).success))
      throw new HttpError(400, "INVALID_ELEMENT_UPDATE", "移动后的线性图元点坐标超出画布范围");
    if (
      !linear &&
      patch.points !== undefined
    )
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
    if (element.type === "text" && patch.width !== undefined) changes.autoResize = false;
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
      Object.assign(
        changes,
        linearGeometry(patch),
      );
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
    const sameLabelStyle = Object.entries(nestedLabelChanges).every(([key, value]) =>
      JSON.stringify((textComparison as unknown as Record<string, unknown> | undefined)?.[key]) === JSON.stringify(value)) &&
      (patch.labelStyle?.fontSize === undefined || patch.labelStyle.fontSize === textComparison?.fontSize) &&
      (patch.labelStyle?.fontFamily === undefined || fontId(patch.labelStyle.fontFamily) === textComparison?.fontFamily) &&
      (patch.labelStyle?.textAlign === undefined || patch.labelStyle.textAlign === textComparison?.textAlign);
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
      const laidOut = isShapeLabel && labelContainer
        ? layoutLabel(labelContainer, measured)
        : {
            ...layoutFreeText(measured, patch.width ?? (!element.autoResize ? element.width : undefined),
              patch.autoResize ?? (patch.width === undefined ? element.autoResize : false)),
            x: patch.x ?? element.x, y: patch.y ?? element.y,
          };
      // Constructors preserve the source version; apply the new text/layout as
      // an element update so remote Store snapshots observe direct text edits.
      const { version: _version, versionNonce: _nonce, updated: _updated, ...textChanges } = laidOut;
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
            fontSize: patch.labelStyle?.fontSize ?? patch.fontSize ?? label.fontSize,
            fontFamily:
              (patch.labelStyle?.fontFamily ?? patch.fontFamily) === undefined
                ? label.fontFamily
                : fontId(patch.labelStyle?.fontFamily ?? patch.fontFamily),
            textAlign: patch.labelStyle?.textAlign ?? patch.textAlign ?? label.textAlign,
          });
          const laidOut = layoutLabel(next, refreshed);
          // Text constructors retain the source version. Existing labels must
          // advance it for Store/History to adopt remote content and layout,
          // while constructor timestamps alone must not create false changes.
          const labelChanges = Object.fromEntries(Object.entries(laidOut).filter(([key, value]) =>
            !["version", "versionNonce", "updated"].includes(key) &&
            JSON.stringify((label as unknown as Record<string, unknown>)[key]) !== JSON.stringify(value)));
          map.set(label.id, existing?.type === "text"
            ? newElementWith(label, labelChanges as never)
            : laidOut);
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
    const changed = applied
      .map((patch) => scene.getNonDeletedElementsMap().get(patch.id))
      .filter((element) => element !== undefined);
    for (const element of changed)
      updateBoundElements(element, scene, { simultaneouslyUpdated: changed });
    elements = [...scene.getElementsIncludingDeleted()];
  } finally {
    scene.destroy();
  }
  return { elements, updatedCount: applied.length };
};
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
  const warnings: { elementId: string; fields: string[]; code?: string; message?: string }[] = [];
  const writableStyle = (element: ExcalidrawElement) => ({
    ...Object.fromEntries(
      Object.keys(style)
        .filter((key) => !["rotation", "roundness"].includes(key))
        .map((key) => [key, (element as unknown as Record<string, unknown>)[key]]),
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
      if (element.containerId && !element.autoResize) fields.push("autoResize", "width");
    }
    if (fields.length) warnings.push({ elementId: element.id, fields });
    const base = { id: element.id, type: element.type, ...writableStyle(element), ...(element.groupIds.length <= 8 && element.groupIds.length ? { groupIds: [...element.groupIds] } : {}) };
    let candidate: Record<string, unknown>;
    if (["rectangle", "ellipse", "diamond"].includes(element.type)) {
      candidate = {
        ...base, x: element.x, y: element.y,
        width: element.width, height: element.height,
      };
      const labelId = element.boundElements?.find((bound) => bound.type === "text")?.id;
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
        ...base, x: element.x, y: element.y,
        text: element.originalText, ...textStyle(element),
        ...(!element.autoResize ? { width: element.width, autoResize: false } : {}),
      };
    } else if (element.type === "line" || element.type === "arrow") {
      candidate = {
        ...base,
        x: element.x,
        y: element.y,
        points: element.points.map(([x, y]) => [x, y]),
      };
      if (element.type === "arrow") Object.assign(candidate, {
        startBinding: element.startBinding,
        endBinding: element.endBinding,
        startArrowhead: element.startArrowhead,
        endArrowhead: element.endArrowhead,
      });
    } else {
      unsupported.add(element.id);
      warnings.push({ elementId: element.id, fields: ["type"], code: "UNSUPPORTED_ELEMENT_TYPE",
        message: `input 视图不支持 ${element.type} 图元；该图元仍在画板中，未删除` });
      continue;
    }
    const parsed = drawingElementSchema.safeParse(candidate);
    if (parsed.success) candidates.set(element.id, parsed.data);
    else {
      unsupported.add(element.id);
      warnings.push({ elementId: element.id,
        fields: [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "element"))],
        code: "UNWRITABLE_ELEMENT",
        message: `图元不符合可写 schema，input 视图已跳过；该图元仍在画板中，未删除：${parsed.error.issues.map((issue) => `${issue.path.join(".") || "element"}: ${issue.message}`).join("；")}` });
    }
  }
  for (const element of active) {
    if (element.type === "text" && element.containerId &&
        !candidates.has(foldedLabels.get(element.id) || "")) {
      unsupported.add(element.id);
      warnings.push({ elementId: element.id, fields: ["containerId"], code: "UNWRITABLE_LABEL_CONTAINER",
        message: `绑定文字的容器 ${element.containerId} 未能投影到 input 视图；文字仍在画板中，未删除` });
    }
  }
  // A projected arrow must not reference a target omitted from the projection.
  // Remove dependent arrows transitively, reporting all missing elements.
  let changed = true;
  while (changed) {
    changed = false;
    const available = new Set([...candidates.keys(), ...[...foldedLabels]
      .filter(([, parentId]) => candidates.has(parentId)).map(([labelId]) => labelId)]);
    for (const [id, spec] of candidates) {
      if (spec.type === "arrow" && [spec.startBinding, spec.endBinding]
        .some((bound) => bound && !available.has(bound.elementId))) {
        candidates.delete(id);
        unsupported.add(id);
        warnings.push({ elementId: id, fields: ["startBinding", "endBinding"], code: "UNWRITABLE_BINDING_TARGET",
          message: "箭头绑定了未能投影到 input 视图的目标，已跳过箭头；箭头仍在画板中，未删除" });
        changed = true;
      }
    }
  }
  return {
    elements: [...candidates.values()],
    labelOwners: new Map([...foldedLabels].filter(([, parentId]) => candidates.has(parentId))),
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
    for (const child of current) {
      const childFields = child as ExcalidrawElement & {
        containerId?: string | null;
      };
      if (childFields.containerId === element.id) {
        idsToRemove.add(child.id);
      }
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
    requestedRemovedCount: current.filter((element) => requested.has(element.id)).length,
    cascadeRemovedCount: current.filter((element) =>
      idsToRemove.has(element.id) && !requested.has(element.id),
    ).length,
    notFoundIds,
  };
};
