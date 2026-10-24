import { describe, expect, it } from "bun:test";
import { LinearElementEditor } from "@excalidraw/element/linearElementEditor";
import type {
  ElementsMap,
  ExcalidrawArrowElement,
  ExcalidrawElement,
  ExcalidrawTextElement,
  ExcalidrawTextElementWithContainer,
} from "@excalidraw/element/types";
import {
  createDrawingBatch,
  drawingElementSchema,
} from "../../server/mcp-drawing";
import { getInspectTextGeometry } from "../../server/mcp-inspect-labels";

const fixture = (points: number[][], rotation = 0) => {
  const native = createDrawingBatch([
    drawingElementSchema.parse({
      type: "arrow",
      id: "edge",
      x: 0,
      y: 0,
      points,
      rotation,
    }),
    drawingElementSchema.parse({
      type: "text",
      id: "label",
      x: -900,
      y: -900,
      text: "箭头说明",
      fontSize: 20,
    }),
  ]).elements;
  const arrow = native[0] as ExcalidrawArrowElement;
  const text = {
    ...native[1],
    containerId: arrow.id,
  } as ExcalidrawTextElementWithContainer;
  const elements: ElementsMap = new Map<string, ExcalidrawElement>([
    [arrow.id, arrow],
    [text.id, text],
  ]);
  return { arrow, text, elements };
};
const budget = () => ({ usedPoints: 0, maxPoints: 200_000 });

describe("MCP native arrow label inspection geometry", () => {
  it("uses displayed midpoint instead of stale stored text coordinates without changing the scene", () => {
    const { text, elements } = fixture([
      [0, 0],
      [400, 0],
    ]);
    const snapshot = structuredClone([...elements.values()]);
    const result = getInspectTextGeometry(text, elements, budget());
    expect(result.geometry?.x).toBeCloseTo(200 - text.width / 2);
    expect(result.geometry?.y).toBeCloseTo(-text.height / 2);
    expect(result.geometry?.x).not.toBe(text.x);
    expect(Number(result.geometry?.angle)).toBe(0);
    expect([...elements.values()]).toEqual(snapshot);
  });

  it("matches native multi-segment and rotated paths while keeping labels horizontal", () => {
    for (const points of [
      [
        [0, 0],
        [100, 100],
        [200, 0],
      ],
      [
        [0, 0],
        [100, 100],
        [200, 100],
        [400, 0],
      ],
    ]) {
      const { arrow, text, elements } = fixture(points, 35);
      const expected = LinearElementEditor.getBoundTextElementPosition(
        arrow,
        text,
        elements,
      );
      const result = getInspectTextGeometry(text, elements, budget());
      expect(result.geometry?.x).toBeCloseTo(expected.x);
      expect(result.geometry?.y).toBeCloseTo(expected.y);
      expect(Number(result.geometry?.angle)).toBe(0);
    }
  });

  it("rejects malformed or too-short native paths before native code can delete a label", () => {
    const { arrow, text } = fixture([
      [0, 0],
      [100, 100],
    ]);
    for (const points of [
      [],
      [[0, 0]],
      [null, [1, 1]],
      [
        [0, NaN],
        [1, 1],
      ],
    ]) {
      const malformed = {
        ...arrow,
        points,
      } as unknown as ExcalidrawArrowElement;
      const elements: ElementsMap = new Map<string, ExcalidrawElement>([
        [malformed.id, malformed],
        [text.id, text],
      ]);
      const snapshot = structuredClone([...elements.values()]);
      expect(
        getInspectTextGeometry(text, elements, budget()).geometry,
      ).toBeNull();
      expect([...elements.values()]).toEqual(snapshot);
      expect(text.isDeleted).toBe(false);
    }
    const elements: ElementsMap = new Map<string, ExcalidrawElement>([
      [arrow.id, arrow],
      [text.id, text],
    ]);
    const rotatedText = {
      ...text,
      angle: 0.5 as ExcalidrawTextElement["angle"],
    };
    expect(
      getInspectTextGeometry(rotatedText, elements, budget()).reason,
    ).toContain("水平");
  });

  it("charges the shared point budget and leaves ordinary text geometry unchanged", () => {
    const { arrow, text, elements } = fixture([
      [0, 0],
      [100, 100],
      [200, 0],
    ]);
    const shared = { usedPoints: 0, maxPoints: 5 };
    expect(
      getInspectTextGeometry(text, elements, shared).geometry,
    ).not.toBeNull();
    expect(shared.usedPoints).toBe(3);
    expect(getInspectTextGeometry(text, elements, shared).reason).toContain(
      "容量",
    );
    expect(shared.usedPoints).toBe(3);
    const plain = { ...text, containerId: null };
    expect(getInspectTextGeometry(plain, elements, shared).geometry).toEqual({
      x: plain.x,
      y: plain.y,
      width: plain.width,
      height: plain.height,
      angle: plain.angle,
    });
    expect(
      getInspectTextGeometry(
        text,
        new Map<string, ExcalidrawElement>(),
        budget(),
      ).reason,
    ).toContain("容器");
    const huge = { ...arrow, points: Array(10_001).fill(arrow.points[0]) };
    expect(
      getInspectTextGeometry(
        text,
        new Map<string, ExcalidrawElement>([
          [huge.id, huge],
          [text.id, text],
        ]),
        budget(),
      ).reason,
    ).toContain("容量");
  });
});
