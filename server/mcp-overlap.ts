import type { ExcalidrawElement } from "@excalidraw/element/types";

const SCENE_LIMIT = 50_000;
const PAIR_LIMIT = 20_000;
const REFERENCE_LIMIT = 200_000;
const CELL_LIMIT = 256;
const WARNING_LIMIT = 20;
const CELL_SIZE = 256;
type Box = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
};

const eligible = (element: ExcalidrawElement) =>
  !element.isDeleted &&
  (element.type === "rectangle" ||
    element.type === "ellipse" ||
    element.type === "diamond" ||
    (element.type === "text" && !element.containerId));

const bounds = (element: ExcalidrawElement): Box | null => {
  const width = Math.abs(element.width),
    height = Math.abs(element.height);
  const cosine = Math.abs(Math.cos(element.angle)),
    sine = Math.abs(Math.sin(element.angle));
  const halfWidth = (width * cosine + height * sine) / 2;
  const halfHeight = (height * cosine + width * sine) / 2;
  const x = element.x + element.width / 2,
    y = element.y + element.height / 2;
  const box = {
    minX: x - halfWidth,
    minY: y - halfHeight,
    maxX: x + halfWidth,
    maxY: y + halfHeight,
    area: 4 * halfWidth * halfHeight,
  };
  return Object.values(box).every(Number.isFinite) && box.area > 0 ? box : null;
};

const overlap = (a: Box, b: Box) => {
  const intersection =
    Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) *
    Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  const small = Math.min(a.area, b.area),
    large = Math.max(a.area, b.area);
  // A larger enclosing box is commonly a group border, panel or container.
  if (intersection >= small * 0.999 && large >= small * 1.25) return 0;
  return intersection / large >= 0.35 ? intersection / small : 0;
};

const cells = (box: Box): string[] | null => {
  const left = Math.floor(box.minX / CELL_SIZE),
    right = Math.floor(box.maxX / CELL_SIZE);
  const top = Math.floor(box.minY / CELL_SIZE),
    bottom = Math.floor(box.maxY / CELL_SIZE);
  if (![left, right, top, bottom].every(Number.isSafeInteger)) return null;
  if ((right - left + 1) * (bottom - top + 1) > CELL_LIMIT) return null;
  const result: string[] = [];
  for (let x = left; x <= right; x++)
    for (let y = top; y <= bottom; y++) result.push(`${x},${y}`);
  return result;
};

/** Advisory only: bounded AABB checks never modify or reject a drawing. */
export const inspectDrawingOverlaps = (
  before: readonly ExcalidrawElement[],
  after: readonly ExcalidrawElement[],
  changedIds: readonly string[],
) => {
  const limitations: string[] = [];
  let complete = true,
    checkedPairs = 0,
    references = 0;
  const incomplete = (reason: string) => {
    complete = false;
    if (!limitations.includes(reason)) limitations.push(reason);
  };
  if (before.length > SCENE_LIMIT || after.length > SCENE_LIMIT)
    incomplete("场景超过 50000 个图元，检测范围已截断");
  const previous = new Map(
    before.slice(0, SCENE_LIMIT).map((element) => [element.id, element]),
  );
  const selected = new Set(changedIds.slice(0, 1000));
  if (changedIds.length > 1000)
    incomplete("变更超过 1000 个图元，检测范围已截断");
  const candidates = after.slice(0, SCENE_LIMIT).filter((element) => {
    if (!selected.has(element.id) || !eligible(element)) return false;
    const old = previous.get(element.id);
    return (
      !old ||
      ["x", "y", "width", "height", "angle"].some(
        (key) =>
          old[key as keyof ExcalidrawElement] !==
          element[key as keyof ExcalidrawElement],
      )
    );
  });
  if (!candidates.length)
    return {
      warnings: [] as {
        code: "ELEMENT_OVERLAP";
        elementId: string;
        otherElementId: string;
        overlapRatio: number;
      }[],
      overlapCheck: {
        complete,
        method: "rotated-aabb" as const,
        threshold: 0.8,
        checkedPairs,
        ...(limitations.length ? { limitations } : {}),
      },
    };
  const index = new Map<string, ExcalidrawElement[]>();
  const largeElements: ExcalidrawElement[] = [];
  const boxMap = new Map<string, Box>();
  for (const element of after.slice(0, SCENE_LIMIT)) {
    if (!eligible(element)) continue;
    const box = bounds(element);
    if (!box) {
      incomplete("部分图元几何无效，已跳过");
      continue;
    }
    boxMap.set(element.id, box);
    const keys = cells(box);
    if (!keys) {
      largeElements.push(element);
      continue;
    }
    if (references + keys.length > REFERENCE_LIMIT) {
      incomplete("空间索引达到容量上限，部分图元未检测");
      continue;
    }
    references += keys.length;
    for (const key of keys) {
      const bucket = index.get(key);
      if (bucket) bucket.push(element);
      else index.set(key, [element]);
    }
  }
  const candidateIds = new Set(candidates.map((element) => element.id));
  const warnings: {
    code: "ELEMENT_OVERLAP";
    elementId: string;
    otherElementId: string;
    overlapRatio: number;
  }[] = [];
  outer: for (const element of candidates) {
    const box = boxMap.get(element.id);
    if (!box) continue;
    const keys = cells(box);
    if (!keys) {
      incomplete("变更图元外接矩形过大，已跳过其重叠检测");
      continue;
    }
    const seen = new Set<string>();
    // Charge every bucket visit, including duplicates, to bound CPU as well as exact comparisons.
    for (const bucket of [
      largeElements,
      ...keys.map((key) => index.get(key) || []),
    ]) {
      for (const other of bucket) {
        if (checkedPairs >= PAIR_LIMIT) {
          incomplete("候选比较达到 20000 次上限，检测未完成");
          break outer;
        }
        checkedPairs++;
        if (
          other.id === element.id ||
          (candidateIds.has(other.id) && other.id < element.id)
        )
          continue;
        if (seen.has(other.id)) continue;
        seen.add(other.id);
        const ratio = overlap(box, boxMap.get(other.id)!);
        if (ratio < 0.8) continue;
        const old = previous.get(element.id),
          oldOther = previous.get(other.id);
        const oldBox = old && bounds(old),
          oldOtherBox = oldOther && bounds(oldOther);
        if (
          oldBox &&
          oldOtherBox &&
          overlap(oldBox, oldOtherBox) >= ratio - 0.1
        )
          continue;
        if (warnings.length >= WARNING_LIMIT) {
          incomplete("重叠提示超过 20 条，结果已截断");
          break outer;
        }
        warnings.push({
          code: "ELEMENT_OVERLAP",
          elementId: element.id,
          otherElementId: other.id,
          overlapRatio: Math.round(ratio * 1000) / 1000,
        });
      }
    }
  }
  return {
    warnings,
    overlapCheck: {
      complete,
      method: "rotated-aabb" as const,
      threshold: 0.8,
      checkedPairs,
      ...(limitations.length ? { limitations } : {}),
    },
  };
};
