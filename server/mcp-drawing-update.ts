import { getSizeFromPoints, rescalePoints } from "@excalidraw/common";
import { newTextElement } from "@excalidraw/element/newElement";
import { newElementWith } from "@excalidraw/element/mutateElement";
import { syncInvalidIndices } from "@excalidraw/element/fractionalIndex";
import { Scene } from "@excalidraw/element/Scene";
import {
  normalizeFixedPoint,
  updateBoundElements,
} from "@excalidraw/element/binding";
import { isArrowElement } from "@excalidraw/element/typeChecks";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import { HttpError } from "./errors";
import { coordinate, validateLinear, type Update } from "./mcp-drawing-schema";
import {
  connect,
  fontId,
  layoutFreeText,
  layoutLabel,
  linearGeometry,
  props,
} from "./mcp-drawing-core";

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
