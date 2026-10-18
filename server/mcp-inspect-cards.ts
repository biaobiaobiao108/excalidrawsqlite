import type { ExcalidrawElement, ExcalidrawTextElement } from "@excalidraw/element/types";

type Reason = "ambiguous" | "no_container" | "limit" | "invalid";
type CardResult = { container: ExcalidrawElement | null; padding: number; heuristic: boolean; reason?: Reason };
const MAX_GROUPS = 32;
const MAX_SCENE_ELEMENTS = 50_000;
const visibleBackground = (element: ExcalidrawElement) => element.type === "rectangle" && !element.isDeleted &&
  element.opacity > 0 && element.fillStyle === "solid" && typeof element.backgroundColor === "string" &&
  element.backgroundColor.toLowerCase() !== "transparent" && !/^#(?:[\da-f]{3}0|[\da-f]{6}00)$/i.test(element.backgroundColor);
const geometryValid = (element: ExcalidrawElement) =>
  [element.x, element.y, element.width, element.height, element.angle].every(Number.isFinite) && element.width > 0 && element.height > 0;
const result = (reason: Reason): CardResult => ({ container: null, padding: 0, heuristic: false, reason });

/** Per-request bounded group index. Group membership, never text position, determines candidates. */
export const createInspectCardResolver = (
  elements: readonly ExcalidrawElement[],
  options: { maxReferences?: number; maxPairs?: number } = {},
) => {
  const bound = (value: number | undefined, maximum: number) => Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value!))) : maximum;
  const maxReferences = bound(options.maxReferences, 200_000), maxPairs = bound(options.maxPairs, 100_000);
  const stats = { references: 0, pairs: 0, skippedAmbiguousContainer: 0, complete: true, limitations: [] as string[] };
  const incomplete = (message: string) => {
    stats.complete = false;
    if (!stats.limitations.includes(message)) stats.limitations.push(message);
  };
  const groups = new Map<string, ExcalidrawElement[]>(), invalidGroups = new Set<string>();
  let indexTruncated = false;
  if (elements.length > MAX_SCENE_ELEMENTS) { incomplete("分组容器索引超过 50000 个图元，已截断"); indexTruncated = true; }
  for (const element of elements.slice(0, MAX_SCENE_ELEMENTS)) {
    if (!element || element.type !== "rectangle" || element.isDeleted || !(element.opacity > 0)) continue;
    if (!Array.isArray(element.groupIds) || element.groupIds.length > MAX_GROUPS) {
      incomplete("部分背景原生分组缺失或超过 32 层，容器索引不完整"); indexTruncated = true;
    }
    for (const group of Array.isArray(element.groupIds) ? element.groupIds.slice(0, MAX_GROUPS) : []) {
      if (stats.references >= maxReferences) { incomplete("分组容器索引达到引用容量上限"); indexTruncated = true; break; }
      stats.references++;
      if (typeof group !== "string" || !group.length) { incomplete("部分原生分组 ID 无效，已跳过"); indexTruncated = true; continue; }
      if (!geometryValid(element) || typeof element.id !== "string") { invalidGroups.add(group); continue; }
      const bucket = groups.get(group);
      if (bucket) bucket.push(element); else groups.set(group, [element]);
    }
  }
  const resolve = (text: ExcalidrawTextElement): CardResult => {
    if (!text || text.isDeleted || text.type !== "text" || typeof text.id !== "string" || !Array.isArray(text.groupIds)) return result("invalid");
    if (!text.groupIds.length) return result("no_container");
    if (text.groupIds.length > MAX_GROUPS) { incomplete("文字原生分组超过 32 层，未推断其容器"); return result("limit"); }
    // Once the global index is partial we cannot safely decide that a group has a unique background.
    if (indexTruncated) return result("limit");
    const match = /^(.*):(title|body)$/.exec(text.id);
    const expectedBackgroundId = match ? `${match[1]}:background` : undefined;
    for (const group of text.groupIds) {
      if (typeof group !== "string" || !group.length) return result("invalid");
      if (invalidGroups.has(group)) { incomplete("同组背景几何无效，未推断其容器"); return result("invalid"); }
      const candidates = groups.get(group) || [];
      let explicit: ExcalidrawElement | undefined;
      const unique = new Map<string, ExcalidrawElement>();
      for (const candidate of candidates) {
        if (stats.pairs >= maxPairs) { incomplete("分组容器候选比较达到容量上限"); return result("limit"); }
        stats.pairs++;
        if (visibleBackground(candidate)) unique.set(candidate.id, candidate);
        if (candidate.id === expectedBackgroundId) explicit = candidate;
      }
      if (explicit) {
        const inferredPadding = text.autoResize === false && Number.isFinite(text.width) && text.width > 0
          ? Math.max(0, (explicit.width - text.width) / 2) : 0;
        const padding = Number.isFinite(inferredPadding) && inferredPadding >= 0 && inferredPadding < Math.min(explicit.width, explicit.height) / 2 ? inferredPadding : 0;
        return { container: explicit, padding, heuristic: false };
      }
      if (unique.size > 1) { stats.skippedAmbiguousContainer++; return result("ambiguous"); }
      if (unique.size === 1) return { container: unique.values().next().value!, padding: 0, heuristic: true };
    }
    return result("no_container");
  };
  return { resolve, stats };
};

/** Optional geometric heuristic, separate from native group ownership. No inference by full containment. */
export const createInspectGeometryResolver = (
  elements: readonly ExcalidrawElement[],
  options: { maxReferences?: number; maxPairs?: number } = {},
) => {
  const bound = (value: number | undefined, maximum: number) => Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value!))) : maximum;
  const maxReferences = bound(options.maxReferences, 200_000), maxPairs = bound(options.maxPairs, 100_000);
  const stats = { references: 0, pairs: 0, skippedAmbiguousContainer: 0, complete: true, limitations: [] as string[] };
  const incomplete = (message: string) => { stats.complete = false; if (!stats.limitations.includes(message)) stats.limitations.push(message); };
  const candidates: ExcalidrawElement[] = [];
  let indexTruncated = elements.length > MAX_SCENE_ELEMENTS;
  if (indexTruncated) incomplete("几何容器索引超过 50000 个图元，已截断");
  for (const element of elements.slice(0, MAX_SCENE_ELEMENTS)) {
    if (!element || !visibleBackground(element)) continue;
    if (stats.references >= maxReferences) { incomplete("几何容器索引达到引用容量上限"); indexTruncated = true; break; }
    stats.references++;
    if (!geometryValid(element) || typeof element.id !== "string") { incomplete("部分实心矩形几何无效，无法安全推断容器"); indexTruncated = true; continue; }
    candidates.push(element);
  }
  const resolve = (text: ExcalidrawTextElement): CardResult => {
    if (!text || text.isDeleted || text.type !== "text" || !geometryValid(text) || !Array.isArray(text.groupIds)) return result("invalid");
    if (text.containerId || text.groupIds.length) return result("no_container");
    if (indexTruncated) return result("limit");
    // Use the displayed top-left corner; a rotated text's stored x/y are unrotated coordinates.
    const tc = Math.cos(text.angle), ts = Math.sin(text.angle);
    const startX = text.x + text.width / 2 - text.width / 2 * tc + text.height / 2 * ts;
    const startY = text.y + text.height / 2 - text.width / 2 * ts - text.height / 2 * tc;
    let owner: ExcalidrawElement | undefined;
    for (const candidate of candidates) {
      if (stats.pairs >= maxPairs) { incomplete("几何容器候选比较达到容量上限"); return result("limit"); }
      stats.pairs++;
      const dx = startX - candidate.x - candidate.width / 2, dy = startY - candidate.y - candidate.height / 2;
      const cosine = Math.cos(candidate.angle), sine = Math.sin(candidate.angle);
      const localX = dx * cosine + dy * sine, localY = -dx * sine + dy * cosine;
      if (Math.abs(localX) > candidate.width / 2 + 1e-7 || Math.abs(localY) > candidate.height / 2 + 1e-7) continue;
      // More than one eligible rectangle, including shadow layers, leaves intent ambiguous.
      if (owner) { stats.skippedAmbiguousContainer++; return result("ambiguous"); }
      owner = candidate;
    }
    return owner ? { container: owner, padding: 0, heuristic: true } : result("no_container");
  };
  return { resolve, stats };
};
