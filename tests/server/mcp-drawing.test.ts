import { describe, expect, it } from "bun:test";
import {
  drawingElementSchema,
  elementUpdateSchema,
  colorSchema,
  createDrawingBatch,
  updateDrawingElements,
  removeDrawingElements,
} from "../../server/mcp-drawing";

const shape = (id: string, x = 0) =>
  drawingElementSchema.parse({
    type: "rectangle",
    id,
    x,
    y: 0,
    width: 100,
    height: 80,
  });
const flow = () =>
  createDrawingBatch([
    shape("a"),
    shape("b", 250),
    drawingElementSchema.parse({
      type: "arrow",
      id: "edge",
      points: [
        [100, 40],
        [175, 40],
        [175, 100],
        [250, 40],
      ],
      startBinding: { elementId: "a" },
      endBinding: { elementId: "b" },
    }),
  ]).elements;
describe("MCP drawing contracts", () => {
  it("rejects misspelled nested fields and invalid styles", () => {
    for (const extra of [
      { zIndex: 999 },
      { strokeColour: "#fff" },
      { fillStyles: "solid" },
    ])
      expect(
        drawingElementSchema.safeParse({ ...shape("a"), ...extra }).success,
      ).toBe(false);
    expect(
      drawingElementSchema.safeParse({ ...shape("a"), opacity: 50.5 }).success,
    ).toBe(true);
    for (const color of ["#ggg", "#12", "not-a-color", "url(https://x)"])
      expect(colorSchema.safeParse(color).success).toBe(false);
    for (const color of ["#fff", "#123456", "#12345678", "transparent", "red"])
      expect(colorSchema.safeParse(color).success).toBe(true);
    expect(
      elementUpdateSchema.safeParse({ id: "a", strokeColour: "#fff" }).success,
    ).toBe(false);
  });
  it("binds both arrow endpoints to stable same-batch IDs and preserves all bend points", () => {
    const elements = flow();
    const edge = elements.find((e) => e.id === "edge")!;
    expect(edge).toMatchObject({
      type: "arrow",
      points: [
        [0, 0],
        [75, 0],
        [75, 60],
        [150, 0],
      ],
      startBinding: { elementId: "a", fixedPoint: [1, 0.5001], mode: "orbit" },
      endBinding: { elementId: "b", fixedPoint: [0, 0.5001], mode: "orbit" },
    });
    expect(elements.find((e) => e.id === "a")!.boundElements).toEqual([
      { type: "arrow", id: "edge" },
    ]);
    expect(elements.find((e) => e.id === "b")!.boundElements).toEqual([
      { type: "arrow", id: "edge" },
    ]);
    expect(() => createDrawingBatch([shape("a")], elements)).toThrow("重复");
    expect(() =>
      createDrawingBatch([
        drawingElementSchema.parse({
          type: "arrow",
          points: [
            [0, 0],
            [100, 0],
          ],
          endBinding: { elementId: "missing" },
        }),
      ]),
    ).toThrow("绑定目标");
  });
  it("changes style in place and uses native binding updates when moving/resizing containers", () => {
    const current = flow();
    const before = structuredClone(current);
    const colored = updateDrawingElements(current, [
      elementUpdateSchema.parse({
        id: "a",
        strokeColor: "#ff0000",
        opacity: 51.25,
        roundness: 12,
        rotation: 15,
      }),
    ]);
    expect(colored.elements.find((e) => e.id === "a")).toMatchObject({
      id: "a",
      strokeColor: "#ff0000",
      opacity: 51.25,
      roundness: { type: 3, value: 12 },
      angle: Math.PI / 12,
    });
    expect(current).toEqual(before);
    const moved = updateDrawingElements(current, [
      elementUpdateSchema.parse({ id: "a", x: 20, width: 120 }),
    ]).elements;
    const arrow = moved.find((e) => e.id === "edge")!;
    expect(arrow.type).toBe("arrow");
    if (arrow.type === "arrow") {
      expect(arrow.x + arrow.points[0][0]).toBeGreaterThan(135);
      expect(arrow.startBinding?.elementId).toBe("a");
      expect(arrow.points.length).toBe(4);
    }
    expect(moved.length).toBe(current.length);
  });
  it("lays out bound text, retains label IDs and cleans reverse bindings on deletion", () => {
    const original = createDrawingBatch([
      drawingElementSchema.parse({
        ...shape("a"),
        text: "很长的文字会自动换行",
        fontFamily: "system",
        textAlign: "left",
        fontSize: 16,
      }),
    ]).elements;
    const label = original.find((e) => e.type === "text")!;
    const changed = updateDrawingElements(original, [
      elementUpdateSchema.parse({
        id: "a",
        x: 40,
        text: "新文字",
        fontSize: 24,
      }),
    ]).elements;
    expect(changed.find((e) => e.id === label.id)).toMatchObject({
      text: "新文字",
      fontSize: 24,
      containerId: "a",
    });
    expect(removeDrawingElements(changed, ["a"]).elements).toEqual([]);
    const remaining = removeDrawingElements(flow(), ["a"]).elements;
    expect(remaining.find((e) => e.id === "edge")).toMatchObject({
      startBinding: null,
      endBinding: { elementId: "b" },
    });
  });
  it("preserves revisions and instances on empty batches or repeated identical edits", () => {
    const current = flow();
    expect(createDrawingBatch([], current).elements[0]).toBe(current[0]);
    expect(updateDrawingElements(current, []).elements[0]).toBe(current[0]);
    const unchanged = updateDrawingElements(current, [
      elementUpdateSchema.parse({ id: "a", x: 0, opacity: 100 }),
      elementUpdateSchema.parse({
        id: "edge",
        startBinding: { elementId: "a", fixedPoint: [1, 0.5] },
      }),
    ]);
    expect(unchanged.updatedCount).toBe(0);
    expect(unchanged.elements).toEqual(current);
    const unbound = updateDrawingElements(current, [
      elementUpdateSchema.parse({ id: "edge", startBinding: null }),
    ]).elements;
    expect(unbound.find((e) => e.id === "a")!.boundElements).toBeNull();
    expect(unbound.find((e) => e.id === "edge")).toMatchObject({
      startBinding: null,
    });
  });
  it("rejects incompatible update fields atomically", () => {
    const current = flow();
    expect(() =>
      updateDrawingElements(current, [
        elementUpdateSchema.parse({
          id: "a",
          points: [
            [0, 0],
            [2, 2],
          ],
        }),
      ]),
    ).toThrow("只有直线");
    expect(() =>
      updateDrawingElements(current, [
        elementUpdateSchema.parse({ id: "edge", text: "no" }),
      ]),
    ).toThrow("不支持文字");
    expect(() =>
      updateDrawingElements(current, [
        elementUpdateSchema.parse({ id: "missing", strokeColor: "red" }),
      ]),
    ).toThrow("不存在");
  });
});
