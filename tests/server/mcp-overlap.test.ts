import { describe, expect, it } from "bun:test";
import { createDrawingBatch, drawingElementSchema } from "../../server/mcp-drawing";
import { inspectDrawingOverlaps } from "../../server/mcp-overlap";

const rectangle = (id: string, x: number, y = 0, width = 100, height = 100) => createDrawingBatch([
  drawingElementSchema.parse({ type: "rectangle", id, x, y, width, height }),
]).elements[0];

describe("MCP advisory drawing overlap checks", () => {
  it("warns about newly overlapping movement and copies without mutating scenes", () => {
    const before = [rectangle("moving", 300), rectangle("stationary", 0)];
    const after = [{ ...before[0], x: 20 }, before[1]];
    const snapshot = structuredClone(after);
    expect(inspectDrawingOverlaps(before, after, ["moving"]).warnings).toEqual([
      { code: "ELEMENT_OVERLAP", elementId: "moving", otherElementId: "stationary", overlapRatio: 0.8 },
    ]);
    expect(inspectDrawingOverlaps(before, [...before, rectangle("copy", 0)], ["copy"]).warnings).toHaveLength(1);
    expect(after).toEqual(snapshot);
  });

  it("ignores existing overlaps, containers and bound labels, but detects new overlaps within a batch once", () => {
    const shapes = [rectangle("a", 0), rectangle("b", 10)];
    expect(inspectDrawingOverlaps(shapes, shapes, ["a"]).warnings).toEqual([]);
    expect(inspectDrawingOverlaps([], shapes, ["a", "b"]).warnings).toHaveLength(1);
    expect(inspectDrawingOverlaps([], [rectangle("frame", -50, -50, 300, 300), rectangle("node", 0)], ["node"]).warnings).toEqual([]);
    const labeled = createDrawingBatch([drawingElementSchema.parse({ type: "rectangle", id: "node", x: 0, y: 0, width: 100, height: 100, text: "标签", labelId: "label" })]).elements;
    expect(inspectDrawingOverlaps([], labeled, ["label"]).warnings).toEqual([]);
  });

  it("uses rotated bounds and explicitly reports incomplete geometry checks", () => {
    const shape = rectangle("rotated", 0);
    const rotated = { ...shape, angle: Math.PI / 4 as typeof shape.angle };
    expect(inspectDrawingOverlaps([], [rotated, { ...rotated, id: "node", x: 20 }], ["rotated"]).warnings).toHaveLength(1);
    const large = inspectDrawingOverlaps([], [rectangle("huge", 0, 0, 100_000, 100_000)], ["huge"]);
    expect(large.overlapCheck.complete).toBe(false);
    expect(large.warnings).toEqual([]);
  });

  it("bounds candidate visits and returned warning count", () => {
    const congested = Array.from({ length: 30 }, (_, index) => rectangle(`target${index}`, 0));
    const result = inspectDrawingOverlaps([], [...congested, rectangle("copy", 0)], ["copy"]);
    expect(result.warnings).toHaveLength(20);
    expect(result.overlapCheck.complete).toBe(false);
    const base = rectangle("base", 30);
    const crowded = Array.from({ length: 20_010 }, (_, index) => ({ ...base, id: `target${index}` }));
    const bounded = inspectDrawingOverlaps([], [...crowded, rectangle("copy", 0, 0, 1, 1)], ["copy"]);
    expect(bounded.overlapCheck.checkedPairs).toBe(20_000);
    expect(bounded.overlapCheck.complete).toBe(false);
  });
});
