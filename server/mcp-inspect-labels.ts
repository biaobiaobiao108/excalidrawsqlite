import { LinearElementEditor } from "@excalidraw/element/linearElementEditor";
import type { ElementsMap, ExcalidrawTextElement, ExcalidrawTextElementWithContainer } from "@excalidraw/element/types";

export type InspectTextGeometry = Pick<ExcalidrawTextElement, "x" | "y" | "width" | "height" | "angle">;
export type InspectLabelBudget = { usedPoints: number; maxPoints: number };
type GeometryResult = { geometry: InspectTextGeometry | null; reason?: string };
const MAX_ARROW_POINTS = 10_000;
const unavailable = (reason: string): GeometryResult => ({ geometry: null, reason });

/** Resolve text's displayed geometry using native arrow-label positioning, without scene mutation. */
export const getInspectTextGeometry = (
  text: ExcalidrawTextElement,
  elements: ElementsMap,
  budget: InspectLabelBudget,
): GeometryResult => {
  if (![text.width, text.height, text.angle].every(Number.isFinite) || text.width <= 0 || text.height <= 0)
    return unavailable("文字尺寸或旋转无效，已跳过文字几何检查");
  if (text.isDeleted) return unavailable("文字已删除，已跳过文字几何检查");
  const container = text.containerId ? elements.get(text.containerId) : undefined;
  if (text.containerId && (!container || container.isDeleted))
    return unavailable("文字容器不存在或已删除，无法确定显示位置");
  if (container?.type !== "arrow") {
    if (![text.x, text.y].every(Number.isFinite)) return unavailable("文字坐标无效，已跳过文字几何检查");
    return { geometry: { x: text.x, y: text.y, width: text.width, height: text.height, angle: text.angle } };
  }
  // The native text layout requires arrow labels to remain horizontal. A nonzero
  // label angle has a different renderer pivot and cannot be treated as a normal text rectangle.
  if (text.angle !== 0) return unavailable("箭头标签旋转不符合原生水平标签约定，已跳过文字几何检查");
  if (![container.x, container.y, container.width, container.height, container.angle].every(Number.isFinite))
    return unavailable("箭头容器几何无效，无法确定标签显示位置");
  if (!Array.isArray(container.points) || container.points.length < 2)
    return unavailable("箭头点不足，无法确定标签显示位置");
  // Native positioning visits the whole path. Charge every call before validation
  // and do not build persistent position/shape caches in the inspection layer.
  const count = container.points.length;
  if (count > MAX_ARROW_POINTS || budget.usedPoints + count > budget.maxPoints)
    return unavailable("箭头标签点检查达到容量上限，已跳过部分文字几何检查");
  budget.usedPoints += count;
  if (container.points.some((point) => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)))
    return unavailable("箭头包含无效点，无法确定标签显示位置");
  try {
    // With fewer than two points this function deletes the label; the guard above
    // prevents that mutation. Stored text.x/y are intentionally ignored here.
    const position = LinearElementEditor.getBoundTextElementPosition(
      container, text as ExcalidrawTextElementWithContainer, elements,
    );
    if (![position.x, position.y].every(Number.isFinite)) return unavailable("原生箭头标签位置无效，已跳过文字几何检查");
    return { geometry: { ...position, width: text.width, height: text.height, angle: text.angle } };
  } catch {
    return unavailable("原生箭头标签布局无法解析此路径，已跳过文字几何检查");
  }
};
