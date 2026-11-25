import * as z from "zod/v4";
import { FONT_FAMILY } from "@excalidraw/common";
import type { FontFamilyValues } from "@excalidraw/element/types";
import { colorSchema } from "./color";

export { colorSchema } from "./color";

export const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const dimension = z.number().finite().positive().max(1_000_000);
const idSchema = z.string().min(1).max(128);
const grouping = {
  groupId: idSchema
    .nullable()
    .optional()
    .describe(
      "原生分组 ID；相同 ID 的图元可整体拖动。null 解除分组；不能与 groupIds 同传",
    ),
  groupIds: z
    .array(idSchema)
    .max(8)
    .refine((ids) => new Set(ids).size === ids.length, "分组 ID 不得重复")
    .optional()
    .describe(
      "原生嵌套分组，从内到外，最多 8 层；[] 解除分组。通常使用 groupId 即可",
    ),
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
export const style = {
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
    fixedPoint: z.tuple([coordinate, coordinate]).optional(),
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
  .array(
    z.tuple([
      z.number().finite().min(-2_000_000).max(2_000_000),
      z.number().finite().min(-2_000_000).max(2_000_000),
    ]),
  )
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
  labelId: idSchema
    .optional()
    .describe("绑定文字图元的稳定 ID；复制 input 视图时保留，通常无需指定"),
  labelStyle: labelStyleSchema
    .optional()
    .describe(
      "绑定文字的独立样式；省略时继承形状样式。文字颜色使用 strokeColor；若形状 strokeColor 与 backgroundColor 相同，继承的文字可能不可见，请显式设置 labelStyle.strokeColor 为与底色对比的颜色",
    ),
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
export const validateLinear = (value: Record<string, unknown>) => {
  if (
    value.x === undefined ||
    value.y === undefined ||
    value.points === undefined
  )
    return false;
  const ps = value.points as number[][];
  if (
    ps.some(
      ([x, y]) =>
        !coordinate.safeParse(x + (value.x as number)).success ||
        !coordinate.safeParse(y + (value.y as number)).success,
    )
  )
    return false;
  return ps.some((p) => p[0] !== ps[0][0] || p[1] !== ps[0][1]);
};
export const isAutomaticArrow = (value: Record<string, unknown>) =>
  value.type === "arrow" &&
  ["points", "x", "y"].every((key) => value[key] === undefined);
const validateArrow = (value: Record<string, unknown>) =>
  isAutomaticArrow(value)
    ? !!value.startBinding && !!value.endBinding && value.rotation === undefined
    : validateLinear(value);
export const drawingElementSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.enum(["rectangle", "ellipse", "diamond"]),
        ...shapeFields,
      })
      .strict(),
    z
      .object({
        type: z.literal("text"),
        ...grouping,
        id: idSchema.optional(),
        x: coordinate,
        y: coordinate,
        text: z.string().min(1).max(10_000),
        width: dimension
          .optional()
          .describe(
            "独立文字的固定换行宽度；省略时按内容自动计算宽度。高度按换行后的内容计算，不传 height",
          ),
        autoResize: z
          .boolean()
          .optional()
          .describe(
            "默认未传 width 时为 true；传 width 时为 false。true 恢复按内容自动计算宽度，不能同时传 width",
          ),
        ...typography,
        ...style,
      })
      .strict()
      .refine(
        (value) => value.autoResize !== false || value.width !== undefined,
        "autoResize=false 时必须提供 width",
      )
      .refine(
        (value) => value.autoResize !== true || value.width === undefined,
        "autoResize=true 时不能同时提供 width",
      ),
    z
      .object({ type: z.literal("line"), ...linearFields })
      .strict()
      .refine(
        validateLinear,
        "请同时提供 x/y 原点和不同的相对 points，所有全局点坐标须在允许范围内",
      )
      .describe(
        "固定坐标线段或折线，不绑定节点；需要随节点移动的无箭头连线，请使用 arrow 并传 endArrowhead:null",
      ),
    z
      .object({
        type: z.literal("arrow"),
        ...linearFields,
        startBinding: binding.optional(),
        endBinding: binding.optional(),
        startArrowhead: arrowhead
          .optional()
          .describe("起点箭头样式，默认 null（无箭头）"),
        endArrowhead: arrowhead
          .optional()
          .describe(
            "终点箭头样式，默认 arrow；null 为无箭头，仍支持节点绑定和自动连接",
          ),
      })
      .strict()
      .refine(
        validateArrow,
        "请同时提供 x/y 原点和不同的相对 points，所有全局点坐标须在允许范围内；也可仅传两端 binding 自动连接（不能同时传 rotation）",
      ),
  ])
  .refine(
    (value) => value.groupId === undefined || value.groupIds === undefined,
    "groupId 与 groupIds 不能同时提供",
  );
export const elementUpdateSchema = z
  .object({
    id: idSchema,
    ...grouping,
    type: z
      .enum(["rectangle", "ellipse", "diamond", "text", "line", "arrow"])
      .optional()
      .describe(
        "可直接使用 input 视图的图元作为 updates；必须与现有类型相同，不支持类型转换",
      ),
    x: coordinate
      .optional()
      .describe("绝对 X；线性图元同时传 points 时，须与 y 成对作为相对点原点"),
    y: coordinate
      .optional()
      .describe("绝对 Y；线性图元同时传 points 时，须与 x 成对作为相对点原点"),
    dx: coordinate
      .optional()
      .describe("相对平移 X；不能与 x 或 points 同时传入，绑定文字请移动容器"),
    dy: coordinate
      .optional()
      .describe("相对平移 Y；不能与 y 或 points 同时传入，绑定文字请移动容器"),
    width: dimension.optional(),
    height: dimension.optional(),
    autoResize: z
      .boolean()
      .optional()
      .describe(
        "仅独立文字使用；true 恢复自动宽度，false 保持固定宽度。传 width 自动启用固定宽度；文字高度始终由内容计算",
      ),
    text: z
      .string()
      .max(10_000)
      .optional()
      .describe(
        "形状及其绑定标签最多 2000 字符；独立文字最多 10000 字符，空字符串清除形状标签",
      ),
    labelId: idSchema
      .optional()
      .describe(
        "仅形状使用；新建标签可指定稳定 ID，已有标签只能传相同 ID，不能重命名",
      ),
    labelStyle: labelStyleSchema
      .optional()
      .describe(
        "仅形状的绑定文字使用；按字段合并独立样式，不修改形状样式；无标签时须同时提供非空 text。文字颜色使用 strokeColor；与底色同色可能不可见，请显式设置 labelStyle.strokeColor 为与底色对比的颜色",
      ),
    ...typography,
    ...style,
    points: points.optional(),
    startBinding: binding.optional(),
    endBinding: binding.optional(),
    startArrowhead: arrowhead.optional(),
    endArrowhead: arrowhead.optional(),
  })
  .strict()
  .refine(
    (value) => value.groupId === undefined || value.groupIds === undefined,
    "groupId 与 groupIds 不能同时提供",
  )
  .refine(
    (value) =>
      !(value.dx !== undefined && value.x !== undefined) &&
      !(value.dy !== undefined && value.y !== undefined),
    "dx 与 x、dy 与 y 不能同时提供",
  )
  .refine(
    (value) =>
      (value.dx === undefined && value.dy === undefined) ||
      value.points === undefined,
    "相对平移不能与 points 同时提供",
  )
  .refine(
    (value) => value.points === undefined || validateLinear(value),
    "修改 points 时 x/y 原点须成对提供，points 须不同且所有全局点坐标须在允许范围内",
  )
  .refine(
    (value) => value.autoResize !== true || value.width === undefined,
    "autoResize=true 时不能同时提供 width",
  )
  .refine((v) => Object.keys(v).length > 1, "请提供至少一个修改字段");

export type Spec = z.infer<typeof drawingElementSchema>;
export type Update = z.infer<typeof elementUpdateSchema>;
