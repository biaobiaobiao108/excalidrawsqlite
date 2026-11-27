import {
  newElement,
  newTextElement,
  newLinearElement,
  newArrowElement,
} from "@excalidraw/element/newElement";
import { syncInvalidIndices } from "@excalidraw/element/fractionalIndex";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import { HttpError } from "./errors";
import { isAutomaticArrow, type Spec } from "./mcp-drawing-schema";
import {
  connect,
  fontId,
  geometry,
  layoutFreeText,
  layoutLabel,
  linearGeometry,
  props,
} from "./mcp-drawing-core";

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
export { measureDrawingText } from "./mcp-drawing-core";
export { updateDrawingElements } from "./mcp-drawing-update";

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
  if (!spec.text) {
    if (spec.labelId) {
      throw new HttpError(
        400,
        "MISSING_LABEL_TEXT",
        "指定 labelId 时必须同时提供 text",
      );
    }
    return [shape];
  }
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
