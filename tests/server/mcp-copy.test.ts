import { describe, expect, it } from "bun:test";
import { copyDrawingSelection } from "../../server/mcp-copy";
import {
  createDrawingBatch,
  drawingElementSchema,
} from "../../server/mcp-drawing";
import type { ExcalidrawElement } from "@excalidraw/element/types";

const source = () =>
  createDrawingBatch(
    [
      {
        type: "rectangle",
        id: "a",
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        text: "起点",
        labelId: "caption",
      },
      { type: "rectangle", id: "b", x: 300, y: 0, width: 100, height: 80 },
      {
        type: "arrow",
        id: "edge",
        x: 100,
        y: 40,
        points: [
          [0, 0],
          [200, 0],
        ],
        startBinding: { elementId: "a" },
        endBinding: { elementId: "b" },
      },
      {
        type: "text",
        id: "note",
        x: 0,
        y: 200,
        width: 80,
        text: "固定宽度文字复制测试",
      },
    ].map((value) => drawingElementSchema.parse(value)),
  ).elements;

describe("MCP drawing selection copies", () => {
  it("allocates fresh IDs, translates geometry and reconnects internal bindings without mutating the source", () => {
    const current = source();
    const before = structuredClone(current);
    const copied = copyDrawingSelection(
      current,
      ["caption", "a", "b", "edge", "note"],
      current,
      50,
      100,
      false,
    );
    expect(copied.elements).toHaveLength(4);
    expect(Object.keys(copied.idMap)).toHaveLength(5);
    expect(new Set(Object.values(copied.idMap)).size).toBe(5);
    for (const id of Object.values(copied.idMap))
      expect(current.some((element) => element.id === id)).toBe(false);
    const created = createDrawingBatch(copied.elements, current).created;
    expect(
      created.find((element) => element.id === copied.idMap.a),
    ).toMatchObject({ x: 50, y: 100 });
    expect(
      created.find((element) => element.id === copied.idMap.caption),
    ).toMatchObject({ containerId: copied.idMap.a });
    expect(
      created.find((element) => element.id === copied.idMap.edge),
    ).toMatchObject({
      startBinding: { elementId: copied.idMap.a },
      endBinding: { elementId: copied.idMap.b },
    });
    expect(
      created.find((element) => element.id === copied.idMap.note),
    ).toMatchObject({ width: 80, autoResize: false });
    expect(current).toEqual(before);
  });

  it("detaches unselected targets unless explicitly retained for a same-board copy", () => {
    const current = source();
    const detached = copyDrawingSelection(
      current,
      ["a", "edge"],
      [],
      20,
      20,
      false,
    );
    expect(
      detached.elements.find((element) => element.type === "arrow"),
    ).toMatchObject({
      startBinding: { elementId: detached.idMap.a },
      endBinding: null,
    });
    const retained = copyDrawingSelection(
      current,
      ["edge"],
      current,
      20,
      20,
      true,
    );
    expect(retained.elements[0]).toMatchObject({
      startBinding: { elementId: "a" },
      endBinding: { elementId: "b" },
    });
  });

  it("rejects missing objects and invalid offsets before creating any elements", () => {
    const current = source();
    expect(() =>
      copyDrawingSelection(current, ["missing"], [], 0, 0, false),
    ).toThrow("图元不存在");
    expect(() =>
      copyDrawingSelection(current, ["b"], [], 1_000_000, 0, false),
    ).toThrow("位移导致坐标超出");
    const unsupported = structuredClone(current);
    unsupported[0] = {
      ...unsupported[0],
      type: "image",
    } as unknown as ExcalidrawElement;
    expect(() =>
      copyDrawingSelection(unsupported, ["a"], [], 0, 0, false),
    ).toThrow("不能复制");
  });
});
