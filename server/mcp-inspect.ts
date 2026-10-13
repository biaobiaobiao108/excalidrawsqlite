import * as z from "zod/v4";
import type { ExcalidrawElement, ExcalidrawTextElementWithContainer } from "@excalidraw/element/types";
import { getBoundTextMaxHeight, getBoundTextMaxWidth } from "@excalidraw/element/textElement";
import { LinearElementEditor } from "@excalidraw/element/linearElementEditor";
import { distanceToElement } from "@excalidraw/element/distance";
import { isBindableElement } from "@excalidraw/element/typeChecks";
import { getInspectTextGeometry } from "./mcp-inspect-labels";
import { createInspectCardResolver } from "./mcp-inspect-cards";

export const LAYOUT_CHECKS = ["text_overlap", "text_overflow", "element_collision", "arrow_connection"] as const;
export const inspectLayoutSchema = z.object({
  checks: z.array(z.enum(LAYOUT_CHECKS)).min(1).max(4).optional()
    .describe("可选检查项，默认全部；仅诊断，不修改画板。文字与碰撞基于现有几何尺寸，不是像素渲染"),
}).strict();
type Check = typeof LAYOUT_CHECKS[number];
type Point = [number, number];
type Issue = { type: Check; severity: "error" | "warning"; elementIds: string[]; message: string; suggestion?: string;
  metrics?: { overlapRatio?: number; overlapArea?: number; distance?: number; possibleLayering?: boolean };
  suggestedUpdate?: { id: string; dx: number; dy: number } };
const SCENE_LIMIT = 50_000, PAIR_LIMIT = 100_000, REFERENCE_LIMIT = 200_000, CELL_LIMIT = 256;
const GROUP_LIMIT = 32, ISSUE_LIMIT = 100, POINT_LIMIT = 200_000, CELL_SIZE = 256;
const cross = (a: Point, b: Point, p: Point) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
const area = (polygon: Point[]) => {
  if (!polygon.length) return 0;
  const origin = polygon[0];
  return Math.abs(polygon.reduce((sum, p, i) => {
    const next = polygon[(i + 1) % polygon.length];
    return sum + (p[0] - origin[0]) * (next[1] - origin[1]) - (p[1] - origin[1]) * (next[0] - origin[0]);
  }, 0)) / 2;
};
const within = (polygon: Point[], point: Point) => polygon.every((p, i) => cross(p, polygon[(i + 1) % polygon.length], point) >= -0.001);
const contains = (outer: Point[], inner: Point[]) => inner.every((point) => within(outer, point));
const validGeometry = (element: ExcalidrawElement) => [element.x, element.y, element.width, element.height, element.angle].every(Number.isFinite) && element.width > 0 && element.height > 0;
const polygonFor = (element: ExcalidrawElement): Point[] => {
  const w = Math.abs(element.width), h = Math.abs(element.height);
  const cx = element.x + element.width / 2, cy = element.y + element.height / 2;
  const cosine = Math.cos(element.angle), sine = Math.sin(element.angle);
  const local: Point[] = element.type === "ellipse"
    ? Array.from({ length: 24 }, (_, i) => [Math.cos(i * Math.PI / 12) * w / 2, Math.sin(i * Math.PI / 12) * h / 2])
    : element.type === "diamond" ? [[0, -h / 2], [w / 2, 0], [0, h / 2], [-w / 2, 0]]
      : [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  return local.map(([x, y]) => [cx + x * cosine - y * sine, cy + x * sine + y * cosine]);
};
// Convex clipping computes rotated rectangle intersections instead of their AABBs.
const intersectionArea = (subject: Point[], clip: Point[]) => {
  let result = subject;
  for (let i = 0; i < clip.length && result.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length], input = result; result = [];
    for (let j = 0; j < input.length; j++) {
      const start = input[j], end = input[(j + 1) % input.length];
      const ds = cross(a, b, start), de = cross(a, b, end), insideStart = ds >= 0, insideEnd = de >= 0;
      if (insideStart !== insideEnd) {
        const t = ds / (ds - de); result.push([start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t]);
      }
      if (insideEnd) result.push(end);
    }
  }
  return area(result);
};
const keysFor = (polygon: Point[]) => {
  const xs = polygon.map((p) => p[0]), ys = polygon.map((p) => p[1]);
  const left = Math.floor(Math.min(...xs) / CELL_SIZE), right = Math.floor(Math.max(...xs) / CELL_SIZE);
  const top = Math.floor(Math.min(...ys) / CELL_SIZE), bottom = Math.floor(Math.max(...ys) / CELL_SIZE);
  if (![left, right, top, bottom].every(Number.isSafeInteger) || (right - left + 1) * (bottom - top + 1) > CELL_LIMIT) return null;
  const keys: string[] = [];
  for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) keys.push(`${x},${y}`);
  return keys;
};
const shape = (element: ExcalidrawElement) => ["rectangle", "ellipse", "diamond"].includes(element.type);
const visible = (element: ExcalidrawElement) => element.opacity !== 0 &&
  (element.type !== "text" || (typeof element.text === "string" && element.text.trim().length > 0));
const possibleLayering = (a: ExcalidrawElement, b: ExcalidrawElement) => {
  if (a.type !== "rectangle" || b.type !== "rectangle" || a.fillStyle !== "solid" || b.fillStyle !== "solid" ||
    a.backgroundColor === "transparent" || b.backgroundColor === "transparent") return false;
  const angle = Math.abs(Math.atan2(Math.sin(a.angle - b.angle), Math.cos(a.angle - b.angle)));
  const offset = Math.hypot(a.x + a.width / 2 - b.x - b.width / 2, a.y + a.height / 2 - b.y - b.height / 2);
  return angle <= Math.PI / 180 && Math.min(a.width, b.width) / Math.max(a.width, b.width) >= 0.95 &&
    Math.min(a.height, b.height) / Math.max(a.height, b.height) >= 0.95 &&
    offset <= Math.min(20, Math.min(a.width, b.width, a.height, b.height) * 0.05);
};
// A proposed translation clears this pair's bounding boxes only; callers must recheck the scene.
const separation = (fixed: Point[], moving: Point[], id: string) => {
  const bounds = (polygon: Point[]) => ({ left: Math.min(...polygon.map((p) => p[0])), right: Math.max(...polygon.map((p) => p[0])),
    top: Math.min(...polygon.map((p) => p[1])), bottom: Math.max(...polygon.map((p) => p[1])) });
  const a = bounds(fixed), b = bounds(moving);
  return [{ id, dx: Math.ceil(a.right - b.left + 8), dy: 0 }, { id, dx: Math.floor(a.left - b.right - 8), dy: 0 },
    { id, dx: 0, dy: Math.ceil(a.bottom - b.top + 8) }, { id, dx: 0, dy: Math.floor(a.top - b.bottom - 8) }]
    .sort((first, second) => Math.abs(first.dx) + Math.abs(first.dy) - Math.abs(second.dx) - Math.abs(second.dy))[0];
};

/** Bounded read-only geometry; no persistent caches or inferred canvas boundaries. */
export const inspectLayout = (elements: readonly ExcalidrawElement[], options: z.infer<typeof inspectLayoutSchema> = {}) => {
  const selected = [...new Set(options.checks ?? LAYOUT_CHECKS)];
  const issues: Issue[] = [];
  const checkInfo = Object.fromEntries(selected.map((name) => [name, {
    complete: true, checkedElements: 0, checkedPairs: 0, issues: 0, limitations: [] as string[],
    ...(name === "text_overflow" ? { skippedNoContainer: 0, skippedAmbiguousContainer: 0, checkedContainers: 0 } : {}),
  }])) as Partial<Record<Check, { complete: boolean; checkedElements: number; checkedPairs: number; issues: number; limitations: string[];
    skippedNoContainer?: number; skippedAmbiguousContainer?: number; checkedContainers?: number;
    groupCandidatePairs?: number; groupReferences?: number }>>;
  const incomplete = (check: Check, reason: string) => {
    const status = checkInfo[check]; if (!status) return; status.complete = false;
    if (!status.limitations.includes(reason)) status.limitations.push(reason);
  };
  const issue = (check: Check, severity: Issue["severity"], elementIds: string[], message: string, suggestion?: string,
    details: Pick<Issue, "metrics" | "suggestedUpdate"> = {}) => {
    const status = checkInfo[check]!;
    if (status.issues >= ISSUE_LIMIT) { incomplete(check, "提示超过 100 条，返回结果已截断"); return; }
    status.issues++; issues.push({ type: check, severity, elementIds, message, ...(suggestion ? { suggestion } : {}), ...details });
  };
  if (elements.length > SCENE_LIMIT) for (const check of selected) incomplete(check, "场景超过 50000 个图元，检查范围已截断");
  const active = elements.slice(0, SCENE_LIMIT).filter((element) => {
    if (!element || typeof element !== "object" || typeof element.id !== "string" || typeof element.type !== "string") {
      for (const check of selected) incomplete(check, "部分图元缺少原生身份字段，已跳过"); return false;
    }
    return !element.isDeleted;
  });
  const map = new Map(active.map((element) => [element.id, element]));
  const labelBudget = { usedPoints: 0, maxPoints: POINT_LIMIT };
  const polygons = new Map<string, Point[]>(), groups = new Map<string, Set<string>>();
  for (const element of active) {
    if (element.type !== "text" && !shape(element)) continue;
    if (element.type === "text" && typeof element.text !== "string") {
      incomplete("text_overlap", "部分文字内容无效，已跳过"); incomplete("text_overflow", "部分文字内容无效，已跳过"); continue;
    }
    if (!visible(element)) continue;
    let displayed = element;
    if (element.type === "text" && checkInfo.text_overlap) {
      const resolved = getInspectTextGeometry(element, map, labelBudget);
      if (!resolved.geometry) { incomplete("text_overlap", resolved.reason!); continue; }
      displayed = { ...element, ...resolved.geometry };
    }
    if (!validGeometry(displayed)) {
      for (const check of element.type === "text" ? ["text_overlap", "text_overflow"] as const : ["element_collision"] as const)
        incomplete(check, "部分图元几何无效，已跳过相关几何检查");
      continue;
    }
    polygons.set(element.id, polygonFor(displayed));
    if (shape(element) && !Array.isArray(element.groupIds)) incomplete("element_collision", "部分图元缺少原生分组字段，分组关联检查已跳过");
    if (shape(element) && (element.groupIds?.length ?? 0) > GROUP_LIMIT) incomplete("element_collision", "部分图元分组超过 32 项，分组判定已截断");
    groups.set(element.id, new Set(Array.isArray(element.groupIds) ? element.groupIds.slice(0, GROUP_LIMIT) : []));
  }
  const sameGroup = (a: ExcalidrawElement, b: ExcalidrawElement) => [...(groups.get(a.id) || [])].some((id) => groups.get(b.id)?.has(id));
  for (const check of ["text_overlap", "element_collision"] as const) {
    if (!checkInfo[check]) continue;
    const candidates = active.filter((element) => polygons.has(element.id) && (check === "text_overlap" ? element.type === "text" : shape(element)));
    checkInfo[check]!.checkedElements = candidates.length;
    const index = new Map<string, ExcalidrawElement[]>(); let references = 0;
    outer: for (const element of candidates) {
      const polygon = polygons.get(element.id)!, keys = keysFor(polygon);
      if (!keys || references + keys.length > REFERENCE_LIMIT) { incomplete(check, "空间索引容量或图元范围超限，部分图元检查已跳过"); continue; }
      const seen = new Set<string>();
      for (const key of keys) for (const other of index.get(key) || []) {
        if (checkInfo[check]!.checkedPairs >= PAIR_LIMIT) { incomplete(check, "候选比较达到 100000 次上限，检查未完成"); break outer; }
        checkInfo[check]!.checkedPairs++;
        if (seen.has(other.id)) continue; seen.add(other.id);
        const otherPolygon = polygons.get(other.id)!;
        // Container containment and grouped card components are intentional composition.
        if (check === "element_collision" && (sameGroup(element, other) || contains(polygon, otherPolygon) || contains(otherPolygon, polygon))) continue;
        const overlap = intersectionArea(polygon, otherPolygon);
        if (overlap <= 1 || overlap / Math.min(area(polygon), area(otherPolygon)) < (check === "text_overlap" ? 0.08 : 0.15)) continue;
        const layering = check === "element_collision" && possibleLayering(element, other);
        // Shape overlaps may be a deliberate shadow or background. Geometry alone cannot safely prescribe a move.
        const suggestedUpdate = check === "text_overlap" && element.type === "text" && !element.containerId ? separation(otherPolygon, polygon, element.id) : undefined;
        issue(check, "warning", [other.id, element.id], check === "text_overlap" ? "文字旋转矩形明显相交，可能影响阅读"
          : layering ? "近似大小的矩形小幅错开，疑似阴影或背景叠层，请确认是否有意设计" : "形状发生明显部分覆盖，可能影响布局",
          suggestedUpdate ? `可将 ${element.id} 平移 dx=${suggestedUpdate.dx}, dy=${suggestedUpdate.dy}；仅分离这对图元，修改后须复查其他碰撞。有意叠放可忽略`
            : check === "element_collision" ? "先确认图层用途；有意叠放可忽略。仅凭几何无法安全建议位移"
              : "调整所属容器的位置、字号或换行；修改后复查实际显示效果",
          { metrics: { overlapRatio: Math.round(overlap / Math.min(area(polygon), area(otherPolygon)) * 1000) / 1000,
            overlapArea: Math.round(overlap * 100) / 100, ...(layering ? { possibleLayering: true } : {}) }, ...(suggestedUpdate ? { suggestedUpdate } : {}) });
        if (checkInfo[check]!.issues >= ISSUE_LIMIT) { incomplete(check, "提示达到 100 条，后续检查已停止"); break outer; }
      }
      references += keys.length;
      for (const key of keys) { const bucket = index.get(key); if (bucket) bucket.push(element); else index.set(key, [element]); }
    }
  }
  if (checkInfo.text_overflow) {
    const resolver = createInspectCardResolver(active);
    for (const element of active) {
      if (element.type !== "text") continue;
      checkInfo.text_overflow.checkedElements++;
      const container = element.containerId ? map.get(element.containerId) : undefined;
      if (element.containerId && !container) {
        if (elements.length > SCENE_LIMIT) incomplete("text_overflow", "容器可能位于截断范围外，未判定为缺失");
        else issue("text_overflow", "error", [element.id, element.containerId], "绑定文字指向不存在或已删除的容器", "恢复容器或解除文字绑定");
        continue;
      }
      if (!visible(element)) continue;
      if (container && shape(container) && (!validGeometry(container) || !validGeometry(element))) {
        incomplete("text_overflow", "文字或所属容器几何无效，溢出检查已跳过"); continue;
      }
      if (container && shape(container) && validGeometry(container) && validGeometry(element)) {
        checkInfo.text_overflow.checkedPairs++;
        checkInfo.text_overflow.checkedContainers!++;
        if (element.width > getBoundTextMaxWidth(container, element) + 1 || element.height > getBoundTextMaxHeight(container, element as ExcalidrawTextElementWithContainer) + 1 ||
          !contains(polygonFor(container), polygonFor(element)))
          issue("text_overflow", "warning", [element.id, container.id], "绑定文字超过原生容器可用文字区域", "增大容器，或减少文字内容与字号");
        continue;
      }
      if (container) continue; // Arrow labels are not constrained to a shape interior.
      const resolved = resolver.resolve(element);
      if (!resolved.container) {
        if (resolved.reason === "no_container") checkInfo.text_overflow.skippedNoContainer!++;
        else if (resolved.reason === "ambiguous") {
          checkInfo.text_overflow.skippedAmbiguousContainer!++;
          incomplete("text_overflow", "部分分组存在多个背景候选，无法可靠确定文字容器");
        } else incomplete("text_overflow", "部分分组容器检查因无效数据或容量限制跳过");
        continue;
      }
      if (!validGeometry(element)) { incomplete("text_overflow", "部分分组文字几何无效，已跳过溢出检查"); continue; }
      const card = resolved.container, padding = resolved.padding;
      checkInfo.text_overflow.checkedPairs++;
      checkInfo.text_overflow.checkedContainers!++;
      const interior = { ...card, x: card.x + padding, y: card.y + padding,
        width: card.width - 2 * padding, height: card.height - 2 * padding };
      if (!contains(polygonFor(interior), polygonFor(element))) issue("text_overflow", "warning", [element.id, card.id],
        resolved.heuristic ? "文字超出同组唯一背景矩形；分组容器为结构推断，请确认卡片用途" : "卡片文字超出所属背景的内边界",
        "调整文字位置、换行或卡片尺寸；保留原生分组，修改后复查");
    }
    checkInfo.text_overflow.groupCandidatePairs = resolver.stats.pairs;
    checkInfo.text_overflow.groupReferences = resolver.stats.references;
    if (!resolver.stats.complete) for (const limitation of resolver.stats.limitations) incomplete("text_overflow", limitation);
  }
  if (checkInfo.arrow_connection) {
    let points = 0;
    for (const element of active) {
      if (element.type !== "arrow") continue;
      checkInfo.arrow_connection.checkedElements++;
      for (const [side, index] of [["startBinding", 0], ["endBinding", -1]] as const) {
        const binding = element[side]; if (!binding) continue; // Decorative unbound arrows are valid.
        if (typeof binding !== "object" || typeof binding.elementId !== "string") { incomplete("arrow_connection", "部分箭头绑定缺少原生目标字段，已跳过"); continue; }
        const target = map.get(binding.elementId);
        if (!target) {
          if (elements.length > SCENE_LIMIT) incomplete("arrow_connection", "绑定目标可能位于截断范围外，未判定为缺失");
          else issue("arrow_connection", "error", [element.id, binding.elementId], `${side} 指向不存在或已删除的图元`, "重新指定绑定目标或显式解除绑定"); continue;
        }
        if (!isBindableElement(target)) { issue("arrow_connection", "error", [element.id, target.id], "箭头目标类型不支持原生绑定", "重新指定可绑定图元"); continue; }
        if (!validGeometry(target) || ![element.x, element.y, element.angle].every(Number.isFinite) || !Array.isArray(element.points) || !element.points.length || points + element.points.length > POINT_LIMIT) {
          incomplete("arrow_connection", "绑定几何缺失或箭头点容量超限，端点距离检查已跳过"); continue;
        }
        points += element.points.length;
        let distance: number;
        try {
          if (element.points.some((point) => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))) {
            incomplete("arrow_connection", "部分箭头点无效，端点距离检查已跳过"); continue;
          }
          const point = LinearElementEditor.getPointAtIndexGlobalCoordinates(element, index, map);
          if (binding.mode === "inside" && within(polygonFor(target), [point[0], point[1]])) continue;
          distance = distanceToElement(target, map, point);
        } catch { incomplete("arrow_connection", "部分绑定轮廓无效，端点距离检查已跳过"); continue; }
        if (!Number.isFinite(distance)) { incomplete("arrow_connection", "部分绑定几何无效，端点距离检查已跳过"); continue; }
        if (distance > Math.max(32, (target.strokeWidth || 1) * 4)) issue("arrow_connection", "warning", [element.id, target.id], `${side} 端点远离绑定目标实际旋转轮廓`, "重新建立绑定并调整箭头端点；特殊长间隙可忽略", { metrics: { distance: Math.round(distance * 100) / 100 } });
      }
    }
  }
  return {
    issues, summary: { errors: issues.filter((item) => item.severity === "error").length, warnings: issues.filter((item) => item.severity === "warning").length },
    complete: Object.values(checkInfo).every((check) => check.complete), checks: checkInfo, scannedElementCount: active.length,
    budgets: { sceneElements: SCENE_LIMIT, comparisonsPerCheck: PAIR_LIMIT, referencesPerIndex: REFERENCE_LIMIT, issuesPerCheck: ISSUE_LIMIT, arrowPoints: POINT_LIMIT, arrowLabelPoints: POINT_LIMIT },
    method: "rotated-convex-geometry",
    limitations: ["使用已存储文字尺寸，不进行真实字体或像素测量。椭圆用内接多边形估计，手绘笔触与圆角不作像素判断",
      "分组仅在明确卡片结构或唯一背景候选时推断容器；没有关联的文字统计为 skippedNoContainer，不代表检查过容器边界。无限画布不检查坐标正负或画布边界",
      "形状碰撞不提供自动位移建议；疑似阴影或背景叠层仅供确认，几何无法确定设计意图"],
  };
};
