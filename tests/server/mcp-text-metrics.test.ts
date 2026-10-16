import { describe, expect, it } from "bun:test";
import { estimateTextLineWidth } from "../../server/mcp-text-metrics";
import { createDrawingBatch, drawingElementSchema, measureDrawingText } from "../../server/mcp-drawing";

describe("MCP approximate text widths", () => {
  it("counts CJK scripts, ideographic space and fullwidth punctuation as one em", () => {
    for (const text of ["中", "あ", "ア", "한", "한", "ㄅ", "𠀀", "，", "。", "（", "）", "\u3000", "Ａ", "１", "￥", "㍑", "﹁"]) {
      expect(estimateTextLineWidth(text, 20)).toBeCloseTo(20, 8);
    }
    expect(estimateTextLineWidth("中文，标点。　Ａ１", 20)).toBeCloseTo(180, 8);
    for (const text of ["A", "1", ",", "(", "ｶ", "｡", "ｱ", "￩"]) {
      expect(estimateTextLineWidth(text, 20)).toBeCloseTo(11.6, 8);
    }
    expect(estimateTextLineWidth("ｶﾞ", 20)).toBeCloseTo(11.6, 8);
    expect(estimateTextLineWidth("ガ", 20)).toBeCloseTo(20, 8);
  });

  it("uses narrow ambiguous punctuation in Western lines and wide punctuation in CJK context", () => {
    expect(estimateTextLineWidth("—…“”‘’·", 20)).toBeCloseTo(7 * 11.6, 8);
    expect(estimateTextLineWidth("中—…“”‘’·", 20)).toBeCloseTo(8 * 20, 8);
    expect(estimateTextLineWidth("A“中”B", 20)).toBeCloseTo(3 * 20 + 2 * 11.6, 8);
    // A mathematical/operator symbol is not automatically a fullwidth character.
    expect(estimateTextLineWidth("中→+©™", 20)).toBeCloseTo(20 + 4 * 11.6, 8);
  });

  it("measures composite emoji as a grapheme and gives combining marks no extra width", () => {
    for (const emoji of ["😀", "👍🏽", "👨‍👩‍👧‍👦", "👩🏽‍💻", "🇨🇳", "1️⃣", "#⃣", "❤️", "©️", "🏳️‍🌈", "👁‍🗨"]) {
      expect(estimateTextLineWidth(emoji, 20)).toBeCloseTo(20, 8);
    }
    expect(estimateTextLineWidth("👍🏽👨‍👩‍👧‍👦🇨🇳1️⃣", 20)).toBeCloseTo(80, 8);
    expect(estimateTextLineWidth("e\u0301A\u0308", 20)).toBeCloseTo(23.2, 8);
    expect(estimateTextLineWidth("\u0301\ufe0f\u200d", 20)).toBe(0);
    expect(estimateTextLineWidth("A😀中e\u0301", 20)).toBeCloseTo(63.2, 8);
  });

  it("keeps measured wrapping and native line heights identical to created text", () => {
    for (const fontFamily of ["Excalifont", "system", "WenKai"] as const) {
      const input = { text: "“中文标点”，全角ＡＢＣ！ Latin e\u0301 👍🏽👩🏽‍💻🇨🇳\n第二行……继续测试。",
        width: 150, fontSize: 20, fontFamily };
      const measured = measureDrawingText(input);
      const element = createDrawingBatch([drawingElementSchema.parse({ type: "text", id: "mixed", x: 0, y: 0, ...input })]).elements[0];
      expect(element.type).toBe("text");
      if (element.type !== "text") throw new Error("expected text");
      expect(measured).toMatchObject({ text: element.text, width: element.width, height: element.height,
        lineHeight: element.lineHeight, lineHeightPx: element.fontSize * element.lineHeight, estimated: true });
      expect(measured.lineCount).toBeGreaterThan(2);
      expect(measured.height).toBeCloseTo(measured.lineCount * measured.lineHeightPx, 8);
      expect(measured).not.toHaveProperty("lines");
    }
  });
});
