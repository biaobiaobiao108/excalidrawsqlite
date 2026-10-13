import { describe, expect, it } from "bun:test";
import { createDrawingBatch, drawingElementSchema } from "../../server/mcp-drawing";
import { inspectLayout, inspectLayoutSchema } from "../../server/mcp-inspect";

const scene = (specs: unknown[]) => createDrawingBatch(specs.map((spec) => drawingElementSchema.parse(spec))).elements;

describe("MCP structural layout diagnostics", () => {
  it("reports bound overflow, same-color text, missing targets and explicit region breaches without mutating", () => {
    const elements = scene([
      { type: "rectangle", id: "card", x: 0, y: 0, width: 200, height: 100, text: "同色", backgroundColor: "#ffffff", strokeColor: "#fff", fillStyle: "solid", labelId: "label" },
      { type: "arrow", id: "arrow", points: [[250, 0], [350, 0]], startBinding: { elementId: "card" } },
    ]);
    const broken = elements.map((element) => element.id === "label" ? { ...element, height: 200 } : element.type === "arrow" && element.startBinding ? { ...element, startBinding: { ...element.startBinding, elementId: "missing" } } : element);
    const snapshot = structuredClone(broken);
    const result = inspectLayout(broken, { region: { x: 0, y: 0, width: 220, height: 110 } });
    const codes = result.warnings.map((warning) => warning.code);
    expect(codes).toContain("BOUND_TEXT_OVERFLOW");
    expect(codes).toContain("TEXT_MATCHES_BACKGROUND");
    expect(codes).toContain("DANGLING_BINDING");
    expect(codes).toContain("UNBOUND_ARROW");
    expect(codes).toContain("OUTSIDE_REGION");
    expect(result.complete).toBe(true);
    expect(broken).toEqual(snapshot);
  });

  it("detects native text line-height mismatch and labels the grouped-card heuristic", () => {
    const elements = scene([
      { type: "rectangle", id: "card", x: 0, y: 0, width: 200, height: 100, groupId: "card-group", fillStyle: "solid", backgroundColor: "white" },
      { type: "text", id: "title", x: 150, y: 20, text: "中文标题", fontSize: 20, groupId: "card-group" },
      { type: "text", id: "body", x: 300, y: 0, text: "第一行\n第二行", fontSize: 20 },
    ]).map((element) => element.id === "body" ? { ...element, height: 1 } : element);
    const result = inspectLayout(elements);
    expect(result.warnings.find((warning) => warning.code === "GROUP_TEXT_OUTSIDE_CARD")?.message).toContain("启发式");
    expect(result.warnings.some((warning) => warning.code === "TEXT_HEIGHT_MISMATCH")).toBe(true);
    expect(result.checks.region.checkedElements).toBe(0);
  });

  it("marks overlap and warning truncation explicitly, including deleted objects", () => {
    const base = scene([{ type: "arrow", id: "base", points: [[0, 0], [100, 0]] }])[0];
    const many = Array.from({ length: 1100 }, (_, index) => ({ ...base, id: `arrow${index}` }));
    const result = inspectLayout([...many, { ...base, id: "deleted", isDeleted: true }]);
    expect(result.summary.activeElementsScanned).toBe(1100);
    expect(result.warnings).toHaveLength(100);
    expect(result.checks.connections.complete).toBe(false);
    expect(result.checks.overlap.complete).toBe(false);
    expect(result.complete).toBe(false);
    expect(inspectLayoutSchema.safeParse({ region: { x: 0, y: 0, width: 0, height: 100 } }).success).toBe(false);
  });

  it("uses absolute linear points for region checks, including backwards arrows", () => {
    const elements = scene([{ type: "arrow", id: "backwards", points: [[100, 100], [0, 0]] }]);
    const result = inspectLayout(elements, { region: { x: 0, y: 0, width: 100, height: 100 } });
    expect(result.warnings.some((warning) => warning.code === "OUTSIDE_REGION")).toBe(false);
    expect(result.warnings.some((warning) => warning.code === "UNBOUND_ARROW")).toBe(true);
  });
});
