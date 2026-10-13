import { describe, expect, it } from "bun:test";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import { createDrawingBatch, drawingElementSchema } from "../../server/mcp-drawing";
import { inspectLayout, inspectLayoutSchema } from "../../server/mcp-inspect";

const scene = (specs: unknown[]) => createDrawingBatch(specs.map((spec) => drawingElementSchema.parse(spec))).elements;
const text = (id: string, x: number, y = 0, rotation = 0) => ({ type: "text", id, x, y, text: "中文文字", fontSize: 20, rotation });
const rectangle = (id: string, x = 0, y = 0, width = 100, height = 100) => ({ type: "rectangle", id, x, y, width, height });

describe("MCP read-only layout diagnostics", () => {
  it("ignores invisible and blank content while preserving data integrity diagnostics", () => {
    const elements = scene([text("visible", 0), text("hidden", 0), text("blank", 0), rectangle("box"), rectangle("hidden-box", 20)]);
    const hidden = elements.map((element) => element.id.startsWith("hidden") ? { ...element, opacity: 0 } :
      element.type === "text" && element.id === "blank" ? { ...element, text: " \n\t" } : element);
    expect(inspectLayout(hidden).issues).toEqual([]);
    const invalidContainer = scene([{ ...rectangle("container"), text: "标签", labelId: "label" }])
      .map((element) => element.id === "container" ? { ...element, width: Number.NaN } : element);
    expect(inspectLayout(invalidContainer, { checks: ["text_overflow"] }).complete).toBe(false);
  });

  it("returns a concrete pair separation that can be reviewed and applied without mutating", () => {
    const elements = scene([text("a", 0), text("b", 10)]);
    const inspected = inspectLayout(elements, { checks: ["text_overlap"] });
    const problem = inspected.issues[0], update = problem.suggestedUpdate!;
    expect(problem.metrics?.overlapRatio).toBeGreaterThan(0.08);
    expect(problem.metrics?.overlapArea).toBeGreaterThan(1);
    expect(update.id).toBe("b");
    const moved = elements.map((element) => element.id === update.id ? { ...element, x: element.x + update.dx, y: element.y + update.dy } : element);
    expect(inspectLayout(moved, { checks: ["text_overlap"] }).issues).toEqual([]);
    expect(elements[1].x).toBe(10);
    const labels = scene([{ ...rectangle("first"), text: "一", labelId: "one" }, { ...rectangle("second", 10), text: "二", labelId: "two" }]);
    expect(inspectLayout(labels, { checks: ["text_overlap"] }).issues[0].suggestedUpdate).toBeUndefined();
  });

  it("keeps intersection measurements stable far from the origin on the infinite canvas", () => {
    const near = scene([text("a", 0), text("b", 10)]);
    const far = near.map((element) => ({ ...element, x: element.x + 1_000_000_000, y: element.y - 1_000_000_000 }));
    const nearby = inspectLayout(near, { checks: ["text_overlap"] }).issues[0];
    const distant = inspectLayout(far, { checks: ["text_overlap"] }).issues[0];
    expect(distant.metrics).toEqual(nearby.metrics);
    expect(distant.suggestedUpdate).toEqual(nearby.suggestedUpdate);
  });
  it("finds overlapping rotated text without treating touching edges or rotated AABBs as overlap", () => {
    const overlapping = scene([text("a", 0), text("b", 10)]);
    const snapshot = structuredClone(overlapping);
    expect(inspectLayout(overlapping, { checks: ["text_overlap"] }).summary.warnings).toBe(1);
    expect(overlapping).toEqual(snapshot);
    const touching = [overlapping[0], { ...overlapping[1], x: overlapping[0].width }];
    expect(inspectLayout(touching, { checks: ["text_overlap"] }).issues).toEqual([]);
    // Long, thin parallel rectangles share AABBs but their actual rotated geometry is disjoint.
    const rotated = scene([text("a", 0, 0, 45), text("b", -25, 25, 45)]);
    expect(inspectLayout(rotated, { checks: ["text_overlap"] }).issues).toEqual([]);
  });

  it("checks native label capacity and displacement but does not infer a free text container", () => {
    const elements = scene([{ ...rectangle("card", -100, -100, 200, 100), text: "绑定文字", labelId: "label" }, text("free", 80, -70)]);
    const oversized = elements.map((element) => element.id === "label" ? { ...element, height: 200 } : element);
    expect(inspectLayout(oversized, { checks: ["text_overflow"] }).issues[0].elementIds).toEqual(["label", "card"]);
    const displaced = elements.map((element) => element.id === "label" ? { ...element, x: 500 } : element);
    expect(inspectLayout(displaced, { checks: ["text_overflow"] }).summary.warnings).toBe(1);
    expect(inspectLayout(elements, { checks: ["text_overflow"] }).issues).toEqual([]);
  });

  it("excludes container containment, frames, same-group composition and arrow crossings", () => {
    const elements = scene([rectangle("background", -100, -100, 500, 500), rectangle("a"), rectangle("b", 20),
      { type: "arrow", id: "decoration", points: [[0, 0], [100, 100]] }]);
    const grouped = elements.map((element) => ["a", "b"].includes(element.id) ? { ...element, groupIds: ["card"] } : element);
    expect(inspectLayout(grouped, { checks: ["element_collision", "arrow_connection"] }).issues).toEqual([]);
    const result = inspectLayout(elements, { checks: ["element_collision"] });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].elementIds).toEqual(["a", "b"]);
  });

  it("reports dangling and distant bindings, accepts valid rotated and inside bindings", () => {
    const elements = scene([{ ...rectangle("a", 0, 0, 400, 300), rotation: 30 }, rectangle("b", 800),
      { type: "arrow", id: "edge", startBinding: { elementId: "a" }, endBinding: { elementId: "b" } }]);
    expect(inspectLayout(elements, { checks: ["arrow_connection"] }).issues).toEqual([]);
    const broken = elements.map((element) => element.type === "arrow" && element.startBinding ? {
      ...element, x: element.x + 1000, startBinding: { ...element.startBinding, elementId: "missing" },
    } : element);
    const result = inspectLayout(broken, { checks: ["arrow_connection"] });
    expect(result.summary).toEqual({ errors: 1, warnings: 1 });
    const inside = scene([rectangle("large", 0, 0, 1000, 1000), { type: "arrow", id: "inside", points: [[500, 500], [1500, 500]], startBinding: { elementId: "large", mode: "inside", fixedPoint: [0.5, 0.5] } }]);
    expect(inspectLayout(inside, { checks: ["arrow_connection"] }).issues).toEqual([]);
  });

  it("bounds issue output and marks partial checks while accepting native incomplete geometry", () => {
    const base = scene([text("base", 0)])[0];
    const many = Array.from({ length: 25 }, (_, index) => ({ ...base, id: `text${index}` }));
    const result = inspectLayout(many, { checks: ["text_overlap"] });
    expect(result.issues).toHaveLength(100);
    expect(result.complete).toBe(false);
    expect(result.checks.text_overlap?.limitations.length).toBeGreaterThan(0);
    const malformed = [{ type: "text", id: "broken" }] as unknown as ExcalidrawElement[];
    expect(inspectLayout(malformed).complete).toBe(false);
    expect(inspectLayoutSchema.safeParse({ checks: ["unknown"] }).success).toBe(false);
    expect(inspectLayoutSchema.safeParse({ checks: [] }).success).toBe(false);
  });

  it("skips malformed arrow points safely and keeps unrelated checks independent", () => {
    const malformed = [
      { id: "edge", type: "arrow", x: 0, y: 0, width: 20, height: 0, angle: 0, points: [null, [1, 1]], startBinding: { elementId: "node" } },
      { id: "node", type: "rectangle", x: 0, y: 0, width: 100, height: 100, angle: 0, strokeWidth: 1 },
    ] as unknown as ExcalidrawElement[];
    expect(inspectLayout(malformed, { checks: ["arrow_connection"] }).complete).toBe(false);
    expect(inspectLayout([malformed[1]], { checks: ["arrow_connection"] }).complete).toBe(true);
    const labels = scene([text("text", 0), { type: "arrow", id: "arrow", points: [[0, 0], [100, 100]] }]);
    const bound = labels.map((element) => element.type === "text" ? { ...element, containerId: "arrow" } : element);
    const result = inspectLayout(bound, { checks: ["text_overlap"] });
    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("checks arrow labels at their displayed location and never proposes moving a bound label", () => {
    const elements = scene([text("label", -900, -900), text("free", 160, -10),
      { type: "arrow", id: "arrow", points: [[0, 0], [400, 0]] }]);
    const bound = elements.map((element) => element.id === "label" && element.type === "text" ? { ...element, containerId: "arrow" } : element);
    const snapshot = structuredClone(bound);
    const result = inspectLayout(bound, { checks: ["text_overlap"] });
    expect(result.complete).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].elementIds).toEqual(["label", "free"]);
    expect(bound).toEqual(snapshot);
    const reordered = [...bound].reverse();
    const reversed = inspectLayout(reordered, { checks: ["text_overlap"] });
    expect(reversed.issues[0].suggestedUpdate).toBeUndefined();
  });
});
