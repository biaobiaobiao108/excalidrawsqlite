import { describe, expect, it } from "bun:test";
import { CSS_NAMED_COLORS } from "../../server/color";
import { CaptureUpdateAction, StoreSnapshot } from "@excalidraw/element/store";
import type { OrderedExcalidrawElement, SceneElementsMap } from "@excalidraw/element/types";
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
  it("connects binding-only arrows to native outlines regardless of input order", () => {
    const specs = [
      { type: "arrow", id: "edge", startBinding: { elementId: "a" }, endBinding: { elementId: "b" } },
      shape("a"), { ...shape("b", 300), type: "ellipse" },
    ].map((spec) => drawingElementSchema.parse(spec));
    const created = createDrawingBatch(specs);
    const edge = created.elements.find((element) => element.id === "edge")!;
    expect(edge.type).toBe("arrow");
    if (edge.type !== "arrow") throw new Error("expected arrow");
    expect(edge.x).toBeGreaterThan(100);
    expect(edge.x + edge.points[1][0]).toBeLessThan(300);
    expect(edge.startBinding?.elementId).toBe("a");
    expect(edge.endBinding?.elementId).toBe("b");
    expect(created.created.map((element) => element.id)).toEqual(["edge", "a", "b"]);
    const copy = createDrawingBatch(inputDrawingElements(created.elements).elements);
    expect(inputDrawingElements(copy.elements)).toEqual(inputDrawingElements(created.elements));
    const moved = updateDrawingElements(created.elements, [elementUpdateSchema.parse({ id: "a", dx: 20 })]);
    expect(moved.elements.find((element) => element.id === "edge")!.x).toBeGreaterThan(edge.x);
    expect(createDrawingBatch([specs[0]], created.elements.filter((element) => element.id !== "edge"))
      .elements.find((element) => element.id === "edge")!.x).toBeGreaterThan(100);
    for (const spec of [
      { type: "arrow", startBinding: { elementId: "a" } },
      { type: "arrow", startBinding: { elementId: "a" }, endBinding: { elementId: "b" }, startX: 0 },
      { type: "arrow", startBinding: { elementId: "a" }, endBinding: { elementId: "b" }, rotation: 30 },
    ]) expect(drawingElementSchema.safeParse(spec).success).toBe(false);
    expect(() => createDrawingBatch([specs[0]])).toThrow("绑定目标");
    expect(() => createDrawingBatch([shape("a"), drawingElementSchema.parse({ type: "arrow",
      startBinding: { elementId: "a" }, endBinding: { elementId: "a" } })])).toThrow("自连接");
    const inside = createDrawingBatch([shape("a"), shape("b", 300), drawingElementSchema.parse({ type: "arrow", id: "inside",
      startBinding: { elementId: "a", fixedPoint: [0.25, 0.25], mode: "inside" },
      endBinding: { elementId: "b", fixedPoint: [0.75, 0.75], mode: "inside" } })]).elements.find((element) => element.id === "inside")!;
    expect(inside).toMatchObject({ x: 25, y: 20, points: [[0, 0], [350, 40]] });
  });

  it("moves batches with relative coordinates while retaining labels and bindings", () => {
    const current = createDrawingBatch([drawingElementSchema.parse({ ...shape("a"), text: "label", labelId: "caption" }),
      shape("b", 300), drawingElementSchema.parse({ type: "arrow", id: "edge", points: [[100, 40], [300, 40]],
        startBinding: { elementId: "a" }, endBinding: { elementId: "b" } })]).elements;
    const before = structuredClone(current);
    const moved = updateDrawingElements(current, ["a", "b", "edge"].map((id) => elementUpdateSchema.parse({ id, dx: 30, dy: -20 })));
    for (const old of current) {
      const next = moved.elements.find((element) => element.id === old.id)!;
      expect(next.x).toBeCloseTo(old.x + 30);
      expect(next.y).toBeCloseTo(old.y - 20);
    }
    expect(moved.updatedCount).toBe(3);
    expect(updateDrawingElements(moved.elements, [elementUpdateSchema.parse({ id: "a", dx: 0, dy: 0 })]).updatedCount).toBe(0);
    expect(() => updateDrawingElements(current, [elementUpdateSchema.parse({ id: "caption", dx: 10 })])).toThrow("所属容器");
    expect(() => updateDrawingElements(current, [elementUpdateSchema.parse({ id: "b", dx: 1_000_000 })])).toThrow("超出画布范围");
    for (const input of [{ id: "a", x: 0, dx: 1 }, { id: "a", y: 0, dy: 1 },
      { id: "edge", dx: 1, points: [[0, 0], [10, 10]] }]) expect(elementUpdateSchema.safeParse(input).success).toBe(false);
    expect(current).toEqual(before);
  });

  it("accepts unchanged input projections as updates and checks the optional type", () => {
    const current = createDrawingBatch([drawingElementSchema.parse({ ...shape("box"), text: "label", labelId: "caption" }),
      drawingElementSchema.parse({ type: "text", id: "free", x: 200, y: 200, text: "a long line", width: 60 }),
      drawingElementSchema.parse({ type: "line", id: "line", points: [[0, 100], [100, 100]] }),
      drawingElementSchema.parse({ type: "arrow", id: "edge", points: [[100, 40], [200, 200]], startBinding: { elementId: "box" } }),
    ]).elements;
    const projection = inputDrawingElements(current);
    expect(projection.labelOwners.get("caption")).toBe("box");
    const updates = projection.elements.map((element) => elementUpdateSchema.parse(element));
    expect(updateDrawingElements(current, updates).updatedCount).toBe(0);
    expect(() => updateDrawingElements(current, [elementUpdateSchema.parse({ id: "box", type: "ellipse", x: 10 })])).toThrow("不支持类型转换");
    const damaged = current.map((element) => element.id === "box" ? { ...element, width: 0 } : element);
    expect(inputDrawingElements(damaged).labelOwners.size).toBe(0);
  });

  it("creates fixed-width text and preserves wrapping through updates and input copies", () => {
    const text = "中文自动换行测试以及更多内容";
    const current = createDrawingBatch([drawingElementSchema.parse({
      type: "text", id: "fixed", x: 20, y: 30, text, width: 80,
      fontSize: 20, textAlign: "right",
    })]).elements;
    const element = current[0];
    if (element.type !== "text") throw new Error("expected text");
    expect(element).toMatchObject({ x: 20, y: 30, width: 80, autoResize: false, originalText: text });
    expect(element.text).toContain("\n");
    expect(element.height).toBeGreaterThan(25);
    const input = inputDrawingElements(current);
    expect(input.warnings).toEqual([]);
    expect(input.elements[0]).toMatchObject({ width: 80, autoResize: false, text });
    expect(inputDrawingElements(createDrawingBatch(input.elements).elements)).toEqual(input);

    const changed = updateDrawingElements(current, [elementUpdateSchema.parse({ id: "fixed", text: `${text}${text}`, fontSize: 24 })]);
    const updated = changed.elements[0];
    if (updated.type !== "text") throw new Error("expected text");
    expect(updated.width).toBe(80);
    expect(updated.height).toBeGreaterThan(element.height);
    expect(updated.version).toBeGreaterThan(element.version);
    expect(updateDrawingElements(changed.elements, [elementUpdateSchema.parse({ id: "fixed", text: `${text}${text}`, fontSize: 24 })]).updatedCount).toBe(0);
    const wider = updateDrawingElements(changed.elements, [elementUpdateSchema.parse({ id: "fixed", width: 160 })]).elements[0];
    expect(wider.width).toBe(160);
    expect(wider.height).toBeLessThan(updated.height);
    const automatic = updateDrawingElements(changed.elements, [elementUpdateSchema.parse({ id: "fixed", autoResize: true })]).elements[0];
    if (automatic.type !== "text") throw new Error("expected text");
    expect(automatic.autoResize).toBe(true);
    expect(automatic.text).toBe(automatic.originalText);
    expect(automatic.width).toBeGreaterThan(80);
    expect(current[0]).toEqual(element);
  });

  it("enables fixed width even at the current natural width and rejects unsupported text sizing", () => {
    const current = createDrawingBatch([drawingElementSchema.parse({ type: "text", id: "free", x: 0, y: 0, text: "text" })]).elements;
    const fixed = updateDrawingElements(current, [elementUpdateSchema.parse({ id: "free", width: current[0].width })]);
    expect(fixed.updatedCount).toBe(1);
    expect(fixed.elements[0]).toMatchObject({ autoResize: false, width: current[0].width });
    expect(() => updateDrawingElements(current, [elementUpdateSchema.parse({ id: "free", height: 100 })])).toThrow("height 由内容自动计算");
    const bound = createDrawingBatch([drawingElementSchema.parse({ ...shape("box"), text: "label", labelId: "label" })]).elements;
    expect(() => updateDrawingElements(bound, [elementUpdateSchema.parse({ id: "label", width: 100 })])).toThrow("所属形状");
    expect(() => updateDrawingElements(bound, [elementUpdateSchema.parse({ id: "box", autoResize: false })])).toThrow("仅独立文字");
    for (const width of [0, -1, Infinity, NaN, 1_000_001])
      expect(drawingElementSchema.safeParse({ type: "text", x: 0, y: 0, text: "a", width }).success).toBe(false);
  });

  it("lays out direct bound-label updates like updates through the container", () => {
    for (const type of ["rectangle", "ellipse", "diamond"] as const) {
      const current = createDrawingBatch([drawingElementSchema.parse({ ...shape("box"),
        type, text: "a", labelId: "caption", rotation: 30 })]).elements;
      const before = structuredClone(current);
      const changes = { text: "abcdefghijabcdefghijabcdefghij", fontSize: 24, textAlign: "right" as const };
      const direct = updateDrawingElements(current, [elementUpdateSchema.parse({ id: "caption", ...changes })]);
      const throughContainer = updateDrawingElements(current, [elementUpdateSchema.parse({ id: "box", ...changes })]);
      const caption = direct.elements.find((element) => element.id === "caption")!;
      const expected = throughContainer.elements.find((element) => element.id === "caption")!;
      for (const key of ["text", "originalText", "x", "y", "width", "height", "angle", "fontSize", "textAlign"] as const)
        expect(caption[key as keyof typeof caption]).toEqual(expected[key as keyof typeof expected]);
      expect(caption.version).toBeGreaterThan(current.find((element) => element.id === "caption")!.version);
      expect(direct.elements.find((element) => element.id === "box")).toEqual(current[0]);
      expect(updateDrawingElements(direct.elements, [elementUpdateSchema.parse({ id: "caption", ...changes })]).updatedCount).toBe(0);
      expect(current).toEqual(before);
    }
  });

  it("advances existing label versions so remote text, style and layout update the Store baseline", () => {
    let current = createDrawingBatch([drawingElementSchema.parse({ ...shape("box"),
      text: "old", labelId: "caption" })]).elements;
    let snapshot = StoreSnapshot.create(new Map(current.map((element) => [element.id, element])) as SceneElementsMap,
      StoreSnapshot.empty().appState);
    for (const input of [
      { id: "box", text: "new" },
      { id: "box", labelStyle: { strokeColor: "red", fontSize: 24 } },
      { id: "box", x: 40, width: 160, rotation: 30 },
    ]) {
      const patch = elementUpdateSchema.parse(input);
      const previousLabel = current.find((element) => element.id === "caption")!;
      const changed = updateDrawingElements(current, [patch]);
      const label = changed.elements.find((element) => element.id === "caption")!;
      expect(label.version).toBeGreaterThan(previousLabel.version);
      const nextSnapshot = snapshot.maybeClone(CaptureUpdateAction.NEVER,
        new Map(changed.elements.map((element) => [element.id, element])) as SceneElementsMap, undefined);
      expect(nextSnapshot).not.toBe(snapshot);
      expect(nextSnapshot.elements.get("caption")).toEqual(label as OrderedExcalidrawElement);
      const repeated = updateDrawingElements(changed.elements, [patch]);
      expect(repeated.updatedCount).toBe(0);
      expect(repeated.elements).toEqual(changed.elements);
      current = changed.elements;
      snapshot = nextSnapshot;
    }
  });

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
    expect(input.elements[0].groupIds).toEqual(["group"]);
    expect(input.warnings).toContainEqual({ elementId: "a", fields: ["frameId", "locked", "link"] });
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
  it("accepts all standard CSS named colors while rejecting context-dependent colors", () => {
    expect(CSS_NAMED_COLORS.length).toBe(148);
    expect(new Set(CSS_NAMED_COLORS).size).toBe(148);
    for (const name of CSS_NAMED_COLORS) {
      expect(colorSchema.parse(name)).toBe(name);
      expect(colorSchema.parse(` ${name.toUpperCase()} `)).toBe(name);
    }
    expect(drawingElementSchema.parse({ ...shape("purple"), strokeColor: "rebeccapurple" }).strokeColor).toBe("rebeccapurple");
    for (const name of ["currentColor", "CanvasText", "inherit", "rebecca-purple"])
      expect(colorSchema.safeParse(name).success).toBe(false);
  });
  it("reports missing deletion IDs and distinguishes explicitly removed elements from cascaded labels", () => {
    const current = createDrawingBatch([
      drawingElementSchema.parse({ ...shape("a"), text: "标签", labelId: "caption" }),
      shape("b", 250),
    ]).elements;
    const before = structuredClone(current);
    const removed = removeDrawingElements(current, ["a", "a", "ghost", "ghost"]);
    expect(removed.elements.map((element) => element.id)).toEqual(["b"]);
    expect(removed).toMatchObject({ removedCount: 2, requestedRemovedCount: 1,
      cascadeRemovedCount: 1, notFoundIds: ["ghost"] });
    expect(removeDrawingElements(current, ["a", "caption"])).toMatchObject({
      removedCount: 2, requestedRemovedCount: 2, cascadeRemovedCount: 0, notFoundIds: [],
    });
    const missingOnly = removeDrawingElements(current, ["ghost"]);
    expect(missingOnly).toMatchObject({ removedCount: 0, requestedRemovedCount: 0,
      cascadeRemovedCount: 0, notFoundIds: ["ghost"] });
    expect(missingOnly.elements[0]).toBe(current[0]);
    expect(current).toEqual(before);
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
