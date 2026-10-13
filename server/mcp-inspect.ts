import * as z from "zod/v4";
import type { ExcalidrawElement, ExcalidrawTextElementWithContainer } from "@excalidraw/element/types";
import { getBoundTextMaxHeight, getBoundTextMaxWidth } from "@excalidraw/element/textElement";
import { inspectDrawingOverlaps } from "./mcp-overlap";

const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const dimension = z.number().finite().positive().max(1_000_000);
export const inspectLayoutSchema = z.object({
  region: z.object({ x: coordinate, y: coordinate, width: dimension, height: dimension }).strict()
    .optional().describe("可选预期内容边界；报告越界，不裁切或修改画板。无限画布本身没有边界"),
}).strict();

const SCENE_LIMIT = 50_000;
const WARNING_LIMIT = 100;
const GROUP_REFERENCE_LIMIT = 200_000;
const GROUP_COMPARISON_LIMIT = 20_000;
const REGION_POINT_LIMIT = 200_000;
type Warning = { code: string; elementId: string; relatedElementId?: string; message: string };
const box = (element: ExcalidrawElement) => {
  const cosine = Math.abs(Math.cos(element.angle)), sine = Math.abs(Math.sin(element.angle));
  const halfWidth = (Math.abs(element.width) * cosine + Math.abs(element.height) * sine) / 2;
  const halfHeight = (Math.abs(element.height) * cosine + Math.abs(element.width) * sine) / 2;
  const centerX = element.x + element.width / 2, centerY = element.y + element.height / 2;
  return { left: centerX - halfWidth, top: centerY - halfHeight, right: centerX + halfWidth, bottom: centerY + halfHeight };
};
const contains = (outer: ReturnType<typeof box>, inner: ReturnType<typeof box>, tolerance = 1) =>
  inner.left >= outer.left - tolerance && inner.top >= outer.top - tolerance &&
  inner.right <= outer.right + tolerance && inner.bottom <= outer.bottom + tolerance;
// Equality only: do not pretend to compute contrast or CSS compositing without a renderer.
const normalizedColor = (color: string) => {
  const value = color.trim().toLowerCase();
  if (/^#[\da-f]{3}$/.test(value)) return `#${[...value.slice(1)].map((char) => char + char).join("")}`;
  return value;
};

/** Read-only, bounded structural diagnostics; these do not replace rendered visual inspection. */
export const inspectLayout = (elements: readonly ExcalidrawElement[], options: z.infer<typeof inspectLayoutSchema> = {}) => {
  const warnings: Warning[] = [];
  const categories = ["text", "connections", "region", "groupContainers"] as const;
  const checks = Object.fromEntries(categories.map((name) => [name, {
    complete: true, checkedElements: 0, warningCount: 0, limitations: [] as string[],
  }])) as Record<typeof categories[number], { complete: boolean; checkedElements: number; warningCount: number; limitations: string[] }>;
  const incomplete = (category: typeof categories[number], message: string) => {
    const check = checks[category];
    check.complete = false;
    if (!check.limitations.includes(message)) check.limitations.push(message);
  };
  const warn = (category: typeof categories[number], warning: Warning) => {
    if (checks[category].warningCount >= WARNING_LIMIT) { incomplete(category, "本类提示超过 100 条，返回已截断"); return; }
    checks[category].warningCount++;
    warnings.push(warning);
  };
  const scanned = elements.slice(0, SCENE_LIMIT);
  const active = scanned.filter((element) => !element.isDeleted);
  const map = new Map(active.map((element) => [element.id, element]));
  if (elements.length > SCENE_LIMIT) for (const category of categories) incomplete(category, "场景超过 50000 个图元，检测范围已截断");
  const groups = new Map<string, ExcalidrawElement[]>();
  let groupReferences = 0, groupComparisons = 0, regionPoints = 0;
  for (const element of active) {
    if (element.type !== "rectangle") continue;
    for (const group of element.groupIds) {
      if (groupReferences >= GROUP_REFERENCE_LIMIT) { incomplete("groupContainers", "分组索引达到 200000 项上限"); break; }
      const bucket = groups.get(group);
      if (bucket) bucket.push(element); else groups.set(group, [element]);
      groupReferences++;
    }
  }
  for (const element of active) {
    if (options.region) {
      checks.region.checkedElements++;
      const region = options.region;
      let bounds: ReturnType<typeof box> | null = box(element);
      if ("points" in element) {
        if (!element.points.length || regionPoints + element.points.length > REGION_POINT_LIMIT) {
          incomplete("region", "线性图元点缺失或检查达到 200000 项上限，部分越界检查已跳过"); bounds = null;
        } else {
        regionPoints += element.points.length;
        let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        for (const [x, y] of element.points) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
        const centerX = (left + right) / 2, centerY = (top + bottom) / 2;
        const cosine = Math.cos(element.angle), sine = Math.sin(element.angle);
        bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
        for (const [x, y] of element.points) {
          const px = element.x + centerX + (x - centerX) * cosine - (y - centerY) * sine;
          const py = element.y + centerY + (x - centerX) * sine + (y - centerY) * cosine;
          bounds.left = Math.min(bounds.left, px); bounds.right = Math.max(bounds.right, px);
          bounds.top = Math.min(bounds.top, py); bounds.bottom = Math.max(bounds.bottom, py);
        }
        }
      }
      if (bounds && !contains({ left: region.x, top: region.y, right: region.x + region.width, bottom: region.y + region.height }, bounds)) {
        warn("region", { code: "OUTSIDE_REGION", elementId: element.id, message: "图元旋转外接矩形超出指定区域；画布本身无限，不代表被裁切" });
      }
    }
    if (element.type === "arrow") {
      checks.connections.checkedElements++;
      for (const side of ["startBinding", "endBinding"] as const) {
        const binding = element[side];
        if (binding && !map.has(binding.elementId)) {
          if (elements.length > SCENE_LIMIT) { incomplete("connections", "绑定目标可能位于截断范围外，未将其判为丢失"); continue; }
          warn("connections", { code: "DANGLING_BINDING", elementId: element.id, relatedElementId: binding.elementId, message: `${side} 指向不存在或已删除的图元` });
        }
      }
      if (!element.startBinding || !element.endBinding) warn("connections", { code: "UNBOUND_ARROW", elementId: element.id, message: "箭头至少一端未绑定，移动节点时不会保持连接；装饰箭头可能有意如此" });
    }
    if (element.type !== "text") continue;
    checks.text.checkedElements++;
    const text = element.text.slice(0, 10_000);
    if (element.text.length > text.length) incomplete("text", "单条文字超过 10000 字符，行高检查已截断");
    const expectedHeight = text.split("\n").length * element.fontSize * element.lineHeight;
    if (expectedHeight > element.height + 1) warn("text", { code: "TEXT_HEIGHT_MISMATCH", elementId: element.id, message: "文字行数与行高超过存储高度，建议重新排版；这里只检查几何数据" });
    const container = element.containerId ? map.get(element.containerId) : undefined;
    if (element.containerId && !container) {
      if (elements.length > SCENE_LIMIT) incomplete("text", "文字容器可能位于截断范围外");
      else warn("text", { code: "MISSING_TEXT_CONTAINER", elementId: element.id, relatedElementId: element.containerId, message: "绑定文字的容器不存在或已删除" });
    }
    if (container && ["rectangle", "ellipse", "diamond"].includes(container.type)) {
      if (element.width > getBoundTextMaxWidth(container, element) + 1 || element.height > getBoundTextMaxHeight(container, element as ExcalidrawTextElementWithContainer) + 1) {
        warn("text", { code: "BOUND_TEXT_OVERFLOW", elementId: element.id, relatedElementId: container.id, message: "绑定文字超过容器原生文字区域，建议增大容器或减少内容/字号" });
      }
      if (container.fillStyle === "solid" && container.backgroundColor !== "transparent" && normalizedColor(container.backgroundColor) === normalizedColor(element.strokeColor)) {
        warn("text", { code: "TEXT_MATCHES_BACKGROUND", elementId: element.id, relatedElementId: container.id, message: "文字颜色与容器实心底色相同，可能不可见；显式设置 labelStyle.strokeColor" });
      }
    }
    if (element.containerId || !element.groupIds.length) continue;
    checks.groupContainers.checkedElements++;
    const bounds = box(element);
    const centerX = (bounds.left + bounds.right) / 2, centerY = (bounds.top + bounds.bottom) / 2;
    let inferred: ExcalidrawElement | undefined, inferredArea = Infinity;
    const seen = new Set<string>();
    groupLoop: for (const group of element.groupIds) {
      // Charge group visits too; huge malformed group arrays cannot bypass the budget.
      if (++groupComparisons > GROUP_COMPARISON_LIMIT) { incomplete("groupContainers", "分组候选比较达到 20000 次上限"); break; }
      for (const candidate of groups.get(group) || []) {
        if (++groupComparisons > GROUP_COMPARISON_LIMIT) { incomplete("groupContainers", "分组候选比较达到 20000 次上限"); break groupLoop; }
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        const candidateBounds = box(candidate), area = Math.abs(candidate.width * candidate.height);
        if (candidate.fillStyle === "solid" && candidate.backgroundColor !== "transparent" &&
          area > Math.abs(element.width * element.height) && area < inferredArea &&
          contains(candidateBounds, { left: centerX, right: centerX, top: centerY, bottom: centerY })) {
          inferred = candidate; inferredArea = area;
        }
      }
    }
    if (inferred && !contains(box(inferred), bounds)) warn("groupContainers", {
      code: "GROUP_TEXT_OUTSIDE_CARD", elementId: element.id, relatedElementId: inferred.id,
      message: "独立文字超出同组且包含其中心的实心矩形；这是卡片容器启发式，分组不等于容器",
    });
  }
  const overlap = inspectDrawingOverlaps([], scanned, active.map((element) => element.id));
  return {
    warnings: [...overlap.warnings.map((warning) => ({ ...warning, message: "高比例旋转外接矩形重叠，可能是有意叠放；不代表像素遮挡" })), ...warnings],
    summary: { activeElementsScanned: active.length, textElements: checks.text.checkedElements, arrows: checks.connections.checkedElements,
      warningCount: warnings.length + overlap.warnings.length },
    complete: overlap.overlapCheck.complete && Object.values(checks).every((check) => check.complete),
    checks: { ...checks, overlap: overlap.overlapCheck, budgets: { sceneElements: SCENE_LIMIT, warningsPerCategory: WARNING_LIMIT,
      overlapWarnings: 20, overlapCandidates: 1000, groupReferences: GROUP_REFERENCE_LIMIT, groupComparisons: GROUP_COMPARISON_LIMIT, regionPoints: REGION_POINT_LIMIT },
      groupReferences, groupComparisons: Math.min(groupComparisons, GROUP_COMPARISON_LIMIT), regionPoints },
    method: "structural-geometry",
    limitations: ["使用存储尺寸和旋转外接矩形，不进行字体像素测量、透明度合成或图像内容检查；未发现提示不保证视觉正确"],
  };
};
