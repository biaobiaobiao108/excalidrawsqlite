import { describe, expect, it } from "bun:test";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import { autoBindArrowEndpoints } from "../../server/mcp-autobind";
import { createDrawingBatch, drawingElementSchema, elementUpdateSchema, updateDrawingElements } from "../../server/mcp-drawing";

const scene = (extra: Record<string, unknown>[] = []) => createDrawingBatch([
  { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 100, roughness: 0 },
  { type: "ellipse", id: "b", x: 300, y: 0, width: 100, height: 100 },
  { type: "arrow", id: "edge", points: [[110, 50], [200, 80], [290, 50]] }, ...extra,
].map((spec) => drawingElementSchema.parse(spec))).elements;

describe("MCP opt-in arrow attachment", () => {
  it("keeps malformed native scenes non-blocking and bounds point processing", () => {
    const source = scene();
    const invalidPoints = source.map((element) => element.type === "arrow" ? { ...element, points: [null, [1, 1]] } : element) as unknown as ExcalidrawElement[];
    const snapshot = structuredClone(invalidPoints);
    const malformed = autoBindArrowEndpoints(invalidPoints, ["edge"]);
    expect(malformed.complete).toBe(false);
    expect(malformed.bindings).toEqual([]);
    expect(malformed.warnings[0].code).toBe("INVALID_AUTO_BIND_GEOMETRY");
    expect(invalidPoints).toEqual(snapshot);
    const invalidTarget = source.map((element) => element.id === "a" ? { ...element, width: NaN } : element);
    expect(autoBindArrowEndpoints(invalidTarget, ["edge"]).complete).toBe(false);
    const oversized = source.map((element) => element.type === "arrow" ? { ...element, points: Array(10_001).fill(element.points[0]) } : element);
    const skipped = autoBindArrowEndpoints(oversized, ["edge"]);
    expect(skipped.complete).toBe(false);
    expect(skipped.checkedPoints).toBe(0);
    expect(skipped.warnings[0].code).toBe("AUTO_BIND_LIMIT");
  });
  it("binds nearby outlines without changing bends and follows later target movement", () => {
    const source = scene();
    const before = structuredClone(source);
    const result = autoBindArrowEndpoints(source, ["edge"]);
    expect(result.complete).toBe(true);
    expect(result.bindings).toHaveLength(2);
    const edge = result.elements.find((element) => element.id === "edge")!;
    expect(edge).toMatchObject({ startBinding: { elementId: "a" }, endBinding: { elementId: "b" } });
    expect(edge).toMatchObject({ x: source[2].x, y: source[2].y, points: (source[2] as typeof edge & { points: unknown }).points });
    expect(result.elements[0].boundElements).toContainEqual({ type: "arrow", id: "edge" });
    expect(source).toEqual(before);
    const moved = updateDrawingElements(result.elements, [elementUpdateSchema.parse({ id: "a", dx: 30 })]).elements;
    expect(moved.find((element) => element.id === "edge")?.x).not.toBe(edge.x);
    expect(autoBindArrowEndpoints(source, []).elements).toEqual(source);
  });

  it("preserves existing bindings and refuses ambiguous or self-connecting inference", () => {
    const current = scene([{ type: "rectangle", id: "same", x: 0, y: 0, width: 100, height: 100 }]);
    const result = autoBindArrowEndpoints(current, ["edge"]);
    expect(result.bindings).toEqual([{ elementId: "edge", endpoint: "endBinding", targetId: "b" }]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "AMBIGUOUS_AUTO_BIND", endpoint: "startBinding" }));
    const explicit = updateDrawingElements(current, [elementUpdateSchema.parse({ id: "edge", startBinding: { elementId: "same" } })]).elements;
    expect(autoBindArrowEndpoints(explicit, ["edge"]).elements.find((element) => element.id === "edge"))
      .toMatchObject({ startBinding: { elementId: "same" }, endBinding: { elementId: "b" } });
    const self = createDrawingBatch([
      { type: "rectangle", id: "box", x: 0, y: 0, width: 100, height: 100 },
      { type: "arrow", id: "loop", points: [[-5, 50], [50, -5]] },
    ].map((spec) => drawingElementSchema.parse(spec))).elements;
    const skipped = autoBindArrowEndpoints(self, ["loop"]);
    expect(skipped.bindings).toEqual([]);
    expect(skipped.warnings[0].code).toBe("AMBIGUOUS_AUTO_BIND");
  });

  it("uses rotated outlines and skips distant decoration with an explicit work bound", () => {
    const rotated = createDrawingBatch([
      { type: "rectangle", id: "box", x: 0, y: 0, width: 100, height: 100, rotation: 45, roundness: null },
      { type: "arrow", id: "edge", points: [[128, 50], [300, 200]] },
    ].map((spec) => drawingElementSchema.parse(spec))).elements;
    expect(autoBindArrowEndpoints(rotated, ["edge"], { maxDistance: 10 }).bindings)
      .toEqual([{ elementId: "edge", endpoint: "startBinding", targetId: "box" }]);
    expect(autoBindArrowEndpoints(scene(), ["edge"], { maxDistance: 1 }).bindings).toEqual([]);
    const tooLarge = Array.from({ length: 1001 }, (_, index) => ({ ...rotated[0], id: `box${index}` }));
    const skipped = autoBindArrowEndpoints(tooLarge, ["edge"]);
    expect(skipped.complete).toBe(false);
    expect(skipped.checkedEndpoints).toBe(0);
    expect(skipped.warnings[0].code).toBe("AUTO_BIND_LIMIT");
    const candidateHeavy = [
      ...Array.from({ length: 500 }, (_, index) => ({ ...rotated[0], id: `target${index}`, x: index * 200 })),
      ...Array.from({ length: 200 }, (_, index) => ({ ...rotated[1], id: `arrow${index}`, y: -10_000 })),
    ];
    const bounded = autoBindArrowEndpoints(candidateHeavy, Array.from({ length: 200 }, (_, index) => `arrow${index}`));
    expect(bounded.complete).toBe(false);
    expect(bounded.checkedEndpoints).toBe(200);
    expect(bounded.bindings).toEqual([]);
    expect(bounded.warnings.length).toBeLessThanOrEqual(100);
    expect(() => autoBindArrowEndpoints(rotated, ["edge"], { maxDistance: Infinity })).toThrow("maxDistance");
  });
});
