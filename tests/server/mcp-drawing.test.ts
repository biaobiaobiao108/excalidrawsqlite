import { describe, expect, it } from "bun:test";
import {
  drawingElementSchema,
  elementUpdateSchema,
  colorSchema,
  createDrawingBatch,
  updateDrawingElements,
  removeDrawingElements,
  inputDrawingElements,
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
  it("updates label styles independently, merges fields and preserves stable label IDs", () => {
    const current = createDrawingBatch([drawingElementSchema.parse({ ...shape("box"), text: "label",
      labelId: "caption", strokeColor: "blue", labelStyle: { strokeColor: "red", fontSize: 16, textAlign: "left" } })]).elements;
    const before = structuredClone(current);
    const changed = updateDrawingElements(current, [elementUpdateSchema.parse({ id: "box", labelId: "caption",
      labelStyle: { fontSize: 24, opacity: 40 } })]);
    expect(changed.updatedCount).toBe(1);
    expect(changed.elements.find((e) => e.id === "box")).toMatchObject({ strokeColor: "blue", opacity: 100 });
    expect(changed.elements.find((e) => e.id === "caption")).toMatchObject({ strokeColor: "red", fontSize: 24, textAlign: "left", opacity: 40, containerId: "box" });
    expect(inputDrawingElements(changed.elements).elements[0]).toMatchObject({ labelId: "caption", labelStyle: { fontSize: 24, strokeColor: "red" } });
    const unchanged = updateDrawingElements(changed.elements, [elementUpdateSchema.parse({ id: "box", labelId: "caption", labelStyle: { fontSize: 24, opacity: 40 } })]);
    expect(unchanged.updatedCount).toBe(0);
    expect(unchanged.elements).toEqual(changed.elements);
    const precedence = elementUpdateSchema.parse({ id: "box", fontSize: 16, fontFamily: "Excalifont", textAlign: "right",
      strokeColor: "blue", labelStyle: { fontSize: 24, fontFamily: "system", textAlign: "left", strokeColor: "red" } });
    const styled = updateDrawingElements(changed.elements, [precedence]);
    expect(styled.elements.find((e) => e.id === "caption")).toMatchObject({ fontSize: 24, fontFamily: 13, textAlign: "left", strokeColor: "red" });
    const repeated = updateDrawingElements(styled.elements, [precedence]);
    expect(repeated.updatedCount).toBe(0);
    expect(repeated.elements).toEqual(styled.elements);
    expect(current).toEqual(before);
  });
  it("creates stable labels through updates and rejects invalid label operations atomically", () => {
    const current = createDrawingBatch([shape("box"), shape("other"),
      drawingElementSchema.parse({ type: "text", id: "free", x: 200, y: 200, text: "free" })]).elements;
    const before = structuredClone(current);
    const changed = updateDrawingElements(current, [elementUpdateSchema.parse({ id: "box", text: "new", labelId: "caption", labelStyle: { fontFamily: "system", fontSize: 30 } })]);
    expect(changed.elements.find((e) => e.id === "box")).toMatchObject({ boundElements: [{ id: "caption", type: "text" }] });
    expect(changed.elements.find((e) => e.id === "caption")).toMatchObject({ fontFamily: 13, fontSize: 30, originalText: "new" });
    expect(() => updateDrawingElements(changed.elements, [elementUpdateSchema.parse({ id: "box", labelId: "renamed" })])).toThrow("不能重命名");
    for (const patch of [
      { id: "free", labelStyle: { fontSize: 30 } },
      { id: "box", labelStyle: { fontSize: 30 } },
      { id: "box", labelId: "caption" },
      { id: "box", text: "new", labelId: "other" },
      { id: "box", text: "", labelStyle: { fontSize: 30 } },
    ]) expect(() => updateDrawingElements(current, [elementUpdateSchema.parse(patch)])).toThrow();
    expect(() => updateDrawingElements(current, [
      elementUpdateSchema.parse({ id: "box", text: "new", labelId: "caption" }),
      elementUpdateSchema.parse({ id: "other", text: "second", labelId: "caption" }),
    ])).toThrow("标签 ID 已存在");
    expect(current).toEqual(before);
    expect(elementUpdateSchema.safeParse({ id: "box", labelStyle: { fontSzie: 30 } }).success).toBe(false);
  });
  it("rejects independently rotated bound labels instead of silently discarding their rotation", () => {
    expect(() => createDrawingBatch([drawingElementSchema.parse({ ...shape("box"), text: "label", labelStyle: { rotation: 30 } })]))
      .toThrow("绑定文字随形状旋转");
    const current = createDrawingBatch([drawingElementSchema.parse({ ...shape("box"), text: "label", rotation: 30, labelStyle: { rotation: 30 } })]).elements;
    const before = structuredClone(current);
    expect(() => updateDrawingElements(current, [elementUpdateSchema.parse({ id: "box", labelStyle: { rotation: 45 } })]))
      .toThrow("绑定文字随形状旋转");
    const changed = updateDrawingElements(current, [elementUpdateSchema.parse({ id: "box", rotation: 45, labelStyle: { rotation: 45 } })]);
    expect(Number(changed.elements.filter((e) => e.type === "text")[0].angle)).toBe(Math.PI / 4);
    const repeated = updateDrawingElements(changed.elements, [elementUpdateSchema.parse({ id: "box", rotation: 45, labelStyle: { rotation: 45 } })]);
    expect(repeated.updatedCount).toBe(0);
    expect(current).toEqual(before);
    expect(Number(createDrawingBatch(inputDrawingElements(changed.elements).elements).elements.filter((e) => e.type === "text")[0].angle)).toBe(Math.PI / 4);
  });
  it("roundtrips writable input with absolute bends, rotation, bindings and stable label IDs", () => {
    const current = createDrawingBatch([
      drawingElementSchema.parse({ ...shape("a"), x: 50, y: 60, rotation: 30,
        text: "多行中文标签", labelId: "label-a", fontSize: 16,
        labelStyle: { strokeColor: "red", fontFamily: "system", textAlign: "left", fontSize: 18 },
        roundness: 12, opacity: 50.5 }),
      drawingElementSchema.parse({ type: "ellipse", id: "b", x: 300, y: 90, width: 100, height: 80 }),
      drawingElementSchema.parse({ type: "arrow", id: "edge", points: [[150, 100], [220, 140], [300, 190]],
        startBinding: { elementId: "a" }, endBinding: { elementId: "b", fixedPoint: [0, 1.36] } }),
      drawingElementSchema.parse({ type: "text", id: "free", x: 20, y: 200, text: "独立文字", textAlign: "right", rotation: 15 }),
      drawingElementSchema.parse({ type: "line", id: "line", points: [[-50, 20], [-10, 40], [60, 10]] }),
    ]).elements;
    const input = inputDrawingElements(current);
    expect(input.unsupportedElementIds).toEqual([]);
    expect(input.elements.length).toBe(5);
    expect(input.elements.find((e) => e.id === "a")).toMatchObject({ labelId: "label-a" });
    expect(input.elements.find((e) => e.id === "a")!.rotation).toBe(30);
    expect(input.elements.find((e) => e.id === "edge")).toMatchObject({ points: [[150, 100], [220, 140], [300, 190]], endBinding: { fixedPoint: [0, 1.36] } });
    const copy = createDrawingBatch(input.elements.map((e) => drawingElementSchema.parse(e))).elements;
    expect(copy.map((e) => e.id)).toEqual(current.map((e) => e.id));
    expect(inputDrawingElements(copy)).toEqual(input);
    const semantic = (elements: typeof current) => elements.map(({ seed, version, versionNonce, updated, index, ...rest }) => rest);
    expect(semantic(copy)).toEqual(semantic(current));
  });
  it("accepts native orbit fixed points outside the target on write/read/write", () => {
    const current = createDrawingBatch([
      drawingElementSchema.parse({ type: "ellipse", id: "oval", x: 100, y: 100, width: 110, height: 110 }),
      drawingElementSchema.parse({ type: "arrow", id: "edge", points: [[0, 250], [100, 250]], endBinding: { elementId: "oval" } }),
    ]).elements;
    const edge = current.find((e) => e.id === "edge")!;
    expect(edge.type === "arrow" && edge.endBinding!.fixedPoint[1]).toBeGreaterThan(1);
    expect(inputDrawingElements(createDrawingBatch(inputDrawingElements(current).elements).elements))
      .toEqual(inputDrawingElements(current));
    expect(drawingElementSchema.safeParse({ type: "arrow", points: [[0, 0], [1, 1]], endBinding: { elementId: "oval", fixedPoint: [0, Infinity] } }).success).toBe(false);
  });
  it("keeps shape-label limits consistent for shapes and direct bound-text updates", () => {
    for (const type of ["rectangle", "ellipse", "diamond"] as const) {
      const current = createDrawingBatch([
        drawingElementSchema.parse({ ...shape("container"), type, text: "label", labelId: "label" }),
      ]).elements;
      const before = structuredClone(current);
      for (const id of ["container", "label"]) {
        const valid = updateDrawingElements(current, [elementUpdateSchema.parse({ id, text: "x".repeat(2_000) })]);
        const input = inputDrawingElements(valid.elements);
        expect(input.elements.length).toBe(1);
        expect(input.unsupportedElementIds).toEqual([]);
        expect(input.elements[0]).toMatchObject({ text: "x".repeat(2_000) });
        expect(() => updateDrawingElements(current, [elementUpdateSchema.parse({ id, text: "x".repeat(2_001) })]))
          .toThrow("形状标签最多 2000 字符");
      }
      expect(current).toEqual(before);
    }
    const free = createDrawingBatch([drawingElementSchema.parse({ type: "text", id: "free", x: 0, y: 0, text: "free" })]).elements;
    const valid = updateDrawingElements(free, [elementUpdateSchema.parse({ id: "free", text: "x".repeat(10_000) })]);
    expect(inputDrawingElements(valid.elements).elements[0]).toMatchObject({ text: "x".repeat(10_000) });
  });
  it("explains omitted oversized labels and dependent arrows in the input projection", () => {
    const current = createDrawingBatch([
      drawingElementSchema.parse({ ...shape("container"), text: "label", labelId: "label" }),
      drawingElementSchema.parse({ type: "arrow", id: "edge", points: [[200, 40], [100, 40]], endBinding: { elementId: "container" } }),
    ]).elements.map((element) => element.type === "text"
      ? { ...element, text: "x".repeat(2_001), originalText: "x".repeat(2_001) }
      : element);
    const input = inputDrawingElements(current);
    expect(input.elements).toEqual([]);
    expect(new Set(input.unsupportedElementIds)).toEqual(new Set(["container", "label", "edge"]));
    expect(input.warnings.find((warning) => warning.elementId === "container")).toMatchObject({ code: "UNWRITABLE_ELEMENT", fields: ["text"] });
    for (const id of input.unsupportedElementIds) {
      const warning = input.warnings.find((item) => item.elementId === id && item.message);
      expect(warning?.message).toContain("仍在画板中");
    }
    expect(input.warnings.find((warning) => warning.elementId === "container")?.message).toContain("2000");
  });
  it("rounds degree conversion noise while preserving fractional rotations", () => {
    for (const rotation of [30, -30, 15, 359.123456789, 0.0000000001]) {
      const current = createDrawingBatch([drawingElementSchema.parse({ ...shape("a"), rotation })]).elements;
      const input = inputDrawingElements(current);
      expect(input.elements[0].rotation).toBe(rotation);
      expect(inputDrawingElements(createDrawingBatch(input.elements).elements)).toEqual(input);
    }
  });
  it("reports unsupported native elements and omitted editor metadata explicitly", () => {
    const current = createDrawingBatch([shape("a")]).elements;
    const modified = { ...current[0], groupIds: ["group"], frameId: "frame", locked: true, link: "https://example.com" };
    const image = { ...current[0], id: "image", type: "image" } as typeof current[number];
    const input = inputDrawingElements([modified, image]);
    expect(input.elements.map((e) => e.id)).toEqual(["a"]);
    expect(input.unsupportedElementIds).toEqual(["image"]);
    expect(input.warnings).toContainEqual({ elementId: "a", fields: ["groupIds", "frameId", "locked", "link"] });
  });
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
