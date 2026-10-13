import { describe, expect, it } from "bun:test";
import { buildDrawingLayout, layoutSchema, measureTextSchema } from "../../server/mcp-layout";
import { createDrawingBatch, drawingElementSchema, elementUpdateSchema, inputDrawingElements,
  measureDrawingText, updateDrawingElements } from "../../server/mcp-drawing";
import { copyDrawingSelection } from "../../server/mcp-copy";

describe("MCP card layout and grouping", () => {
  it("round-trips nested native groups and detaches copied groups from originals", () => {
    const specs = [
      { type: "rectangle", id: "card", groupIds: ["inner", "outer"], x: 0, y: 0, width: 200, height: 100, text: "标签" },
      { type: "text", id: "body", groupIds: ["inner", "outer"], x: 20, y: 120, text: "正文" },
    ].map((spec) => drawingElementSchema.parse(spec));
    const scene = createDrawingBatch(specs).elements;
    expect(scene.every((element) => JSON.stringify(element.groupIds) === JSON.stringify(["inner", "outer"]))).toBe(true);
    const input = inputDrawingElements(scene);
    expect(input.warnings).toEqual([]);
    expect(input.elements.every((element) => element.groupIds?.length === 2)).toBe(true);
    const copied = copyDrawingSelection(scene, ["card", "body"], scene, 30, 0, false);
    expect(copied.groupIdMap.inner).not.toBe("inner");
    expect(copied.groupIdMap.outer).not.toBe("outer");
    const recreated = createDrawingBatch(copied.elements).elements;
    expect(recreated.every((element) => element.groupIds.join() === [copied.groupIdMap.inner, copied.groupIdMap.outer].join())).toBe(true);
    const ungrouped = updateDrawingElements(scene, [elementUpdateSchema.parse({ id: "card", groupId: null })]).elements;
    expect(ungrouped.find((element) => element.id === "card")?.groupIds).toEqual([]);
    expect(ungrouped.find((element) => element.type === "text" && element.containerId === "card")?.groupIds).toEqual([]);
    expect(ungrouped.find((element) => element.id === "body")?.groupIds).toEqual(["inner", "outer"]);
    expect(drawingElementSchema.safeParse({ ...specs[0], groupId: "conflict" }).success).toBe(false);
    expect(elementUpdateSchema.safeParse({ id: "body", groupIds: ["same", "same"] }).success).toBe(false);
  });

  it("measures wrapped Chinese with exactly the same dimensions as text creation", () => {
    const input = measureTextSchema.parse({ text: "一二三四五六七八九十\nhello world", width: 80, fontSize: 20 });
    const measured = measureDrawingText(input);
    const created = createDrawingBatch([drawingElementSchema.parse({ type: "text", x: 0, y: 0, ...input })]).elements[0];
    expect(created).toMatchObject({ width: measured.width, height: measured.height, text: measured.text });
    expect(measured.estimated).toBe(true);
    expect(measured.lineCount).toBeGreaterThan(2);
  });

  it("places tall grouped cards without overlap and keeps wrapped text inside padding", () => {
    const input = layoutSchema.parse({ cards: [
      { id: "one", title: "短标题", body: "中文正文".repeat(50) },
      { id: "two", body: "第二张卡" }, { id: "three", title: "第三张" },
    ], columns: 2, cardWidth: 180, padding: 16 });
    const result = buildDrawingLayout(input);
    const scene = createDrawingBatch(result.elements).elements;
    expect(result.cards[2].y).toBe(result.cards[0].y + Math.max(result.cards[0].height, result.cards[1].height) + input.gap);
    expect(result.cards[1].x).toBe(input.cardWidth + input.gap);
    for (const card of result.cards) {
      const children = scene.filter((element) => element.groupIds.includes(card.groupId));
      expect(children.map((element) => element.id)).toEqual(card.elementIds);
      for (const text of children.filter((element) => element.type === "text")) {
        expect(text.x).toBe(card.x + input.padding);
        expect(text.y + text.height).toBeLessThanOrEqual(card.y + card.height - input.padding);
      }
    }
    expect(layoutSchema.safeParse({ cards: [{ body: "x" }], cardWidth: 40, padding: 20 }).success).toBe(false);
    expect(layoutSchema.safeParse({ cards: [{ id: "a", body: "x" }, { id: "a", body: "y" }] }).success).toBe(false);
  });
});
