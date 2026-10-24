import { describe, expect, it } from "bun:test";
import * as z from "zod/v4";
import { buildDiagram, diagramSchema } from "../../server/mcp-diagram";
import {
  createDrawingBatch,
  drawingElementSchema,
  inputDrawingElements,
  updateDrawingElements,
} from "../../server/mcp-drawing";

const nodes = [
  { id: "a", title: "开始", body: "接收需求" },
  { id: "b", title: "处理" },
  { id: "c", title: "确认" },
  { id: "d", title: "完成" },
];
type Spec = z.infer<typeof drawingElementSchema>;
const boxes = (result: ReturnType<typeof buildDiagram>) =>
  result.elements.filter(
    (
      e,
    ): e is Extract<Spec, { type: "rectangle" | "ellipse" | "diamond" }> & {
      type: "rectangle";
    } => e.type === "rectangle",
  );

describe("MCP semantic diagrams", () => {
  it("builds timelines in input order with bounded standard writable specs and stable bindings", () => {
    for (const direction of ["vertical", "horizontal"] as const) {
      const result = buildDiagram({
        name: "时间线",
        layout: "timeline",
        direction,
        nodes,
      });
      expect(result.nodeCount).toBe(4);
      expect(result.edgeCount).toBe(3);
      const shapes = boxes(result);
      expect(shapes.map((e) => e.id)).toEqual(nodes.map((node) => node.id));
      const axis = direction === "vertical" ? "y" : "x";
      expect(shapes.map((e) => e[axis])).toEqual(
        [...shapes.map((e) => e[axis])].sort((a, b) => a - b),
      );
      result.elements.forEach((element) =>
        expect(drawingElementSchema.safeParse(element).success).toBe(true),
      );
      for (const connector of result.elements.filter(
        (element) => element.type === "arrow",
      )) {
        const from = shapes.find(
          (shape) => shape.id === connector.startBinding!.elementId,
        )!;
        const to = shapes.find(
          (shape) => shape.id === connector.endBinding!.elementId,
        )!;
        const end = connector.points!.at(-1)!;
        expect(connector.points![0]).toEqual([0, 0]);
        expect([connector.x, connector.y]).toEqual(
          direction === "vertical"
            ? [from.x + from.width / 2, from.y + from.height]
            : [from.x + from.width, from.y + from.height / 2],
        );
        expect([connector.x! + end[0], connector.y! + end[1]]).toEqual(
          direction === "vertical"
            ? [to.x + to.width / 2, to.y]
            : [to.x, to.y + to.height / 2],
        );
      }
      expect(
        buildDiagram({ name: "时间线", layout: "timeline", direction, nodes })
          .elements,
      ).toEqual(result.elements);
      const created = createDrawingBatch(result.elements);
      expect(created.created.length).toBe(11);
      const arrow = created.elements.find((e) => e.type === "arrow")!;
      expect(arrow.type === "arrow" && arrow.startBinding?.elementId).toBe("a");
      expect(arrow.type === "arrow" && arrow.endBinding?.elementId).toBe("b");
      const moved = updateDrawingElements(created.elements, [
        { id: "b", x: 700 },
      ]);
      const changed = moved.elements.find((e) => e.id === arrow.id)!;
      expect(changed.type === "arrow" && changed.endBinding?.elementId).toBe(
        "b",
      );
      expect(changed).not.toEqual(arrow);
      const input = inputDrawingElements(created.elements);
      expect(input.unsupportedElementIds).toEqual([]);
      expect(input.elements.length).toBe(7);
    }
  });

  it("ranks branching DAGs by edges and centers rows without overlapping cards", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "d" },
      { from: "c", to: "d" },
    ];
    for (const direction of ["vertical", "horizontal"] as const) {
      const result = buildDiagram({ name: "分支", nodes, edges, direction });
      const [a, b, c, d] = boxes(result);
      const axis = direction === "vertical" ? "y" : "x";
      expect(a[axis]).toBeLessThan(b[axis]);
      expect(b[axis]).toBe(c[axis]);
      expect(d[axis]).toBeGreaterThan(c[axis]);
      for (const first of boxes(result))
        for (const second of boxes(result)) {
          if (first.id === second.id) continue;
          expect(
            first.x + first.width <= second.x ||
              second.x + second.width <= first.x ||
              first.y + first.height <= second.y ||
              second.y + second.height <= first.y,
          ).toBe(true);
        }
      expect(createDrawingBatch(result.elements).created.length).toBe(12);
    }
  });

  it("creates mixed directed and headless bound connectors without changing the default", () => {
    const result = buildDiagram({
      name: "树形图",
      nodes,
      edges: [
        { from: "a", to: "b", endArrowhead: null },
        { from: "a", to: "c" },
      ],
    });
    const created = createDrawingBatch(result.elements);
    const arrows = created.elements.filter(
      (element) => element.type === "arrow",
    );
    expect(
      arrows.map((arrow) => arrow.type === "arrow" && arrow.endArrowhead),
    ).toEqual([null, "arrow"]);
    expect(arrows[0].type === "arrow" && arrows[0].startArrowhead).toBeNull();
    const moved = updateDrawingElements(created.elements, [
      { id: "b", dx: 100 },
    ]);
    const connector = moved.elements.find(
      (element) => element.id === arrows[0].id,
    );
    expect(connector).toMatchObject({
      type: "arrow",
      endArrowhead: null,
      endBinding: { elementId: "b" },
    });
    expect(connector).not.toEqual(arrows[0]);
    expect(
      diagramSchema.safeParse({
        name: "bad",
        nodes,
        edges: [{ from: "a", to: "b", endArrowhead: "circle" }],
      }).success,
    ).toBe(false);
  });

  it("handles cycles, disconnected nodes, skipped ranks and self loops deterministically", () => {
    const result = buildDiagram({
      name: "循环",
      nodes: [...nodes, { id: "diagram_edge_0", title: "孤立" }],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
        { from: "b", to: "c" },
        { from: "c", to: "d" },
        { from: "a", to: "d" },
        { from: "d", to: "d" },
      ],
    });
    expect(boxes(result)[0].y).toBe(boxes(result)[1].y);
    const arrows = result.elements.filter((e) => e.type === "arrow");
    expect(arrows[0].id).toBe("diagram_edge_0_1");
    expect(arrows[0].points?.length).toBe(6);
    expect(arrows[4].points?.length).toBe(6);
    expect(arrows[5].points?.length).toBe(6);
    expect(createDrawingBatch(result.elements).created.length).toBe(16);
    expect(
      inputDrawingElements(createDrawingBatch(result.elements).elements)
        .unsupportedElementIds,
    ).toEqual([]);
    expect(buildDiagram({ name: "无连线", nodes, edges: [] }).edgeCount).toBe(
      0,
    );
  });

  it("sizes cards using actual Chinese and long-label wrapping without clipping", () => {
    const result = buildDiagram({
      name: "长标签",
      theme: "ocean",
      nodes: [
        { id: "chinese", title: "标题", body: "汉字和标点，".repeat(150) },
        {
          id: "latin",
          title: "Latin",
          body: "abcdefghijklmnopqrstuvwxyz".repeat(60),
        },
      ],
    });
    const created = createDrawingBatch(result.elements);
    for (const shape of created.elements.filter(
      (e) => e.type === "rectangle",
    )) {
      const label = created.elements.find(
        (e) => e.type === "text" && e.containerId === shape.id,
      )!;
      expect(label.y).toBeGreaterThanOrEqual(shape.y);
      expect(label.y + label.height).toBeLessThanOrEqual(
        shape.y + shape.height,
      );
      expect(shape.strokeColor).toBe("#315b83");
    }
  });

  it("rejects invalid or unbounded semantic input before drawing", () => {
    expect(() =>
      buildDiagram({ name: "重复", nodes: [nodes[0], nodes[0]] }),
    ).toThrow("nodes.id 必须唯一");
    expect(() =>
      buildDiagram({
        name: "错误目标",
        nodes,
        edges: [{ from: "a", to: "missing" }],
      }),
    ).toThrow("连接目标不存在");
    expect(() =>
      buildDiagram({
        name: "重复连接",
        nodes,
        edges: [
          { from: "a", to: "b" },
          { from: "a", to: "b" },
        ],
      }),
    ).toThrow("重复连接");
    expect(
      diagramSchema.safeParse({ name: "多余字段", nodes, geometry: {} })
        .success,
    ).toBe(false);
    expect(
      diagramSchema.safeParse({
        name: "多余节点字段",
        nodes: [{ ...nodes[0], color: "red" }],
      }).success,
    ).toBe(false);
    expect(
      diagramSchema.safeParse({
        name: "超量",
        nodes: Array.from({ length: 101 }, (_, i) => ({
          id: `${i}`,
          title: "x",
        })),
      }).success,
    ).toBe(false);
    expect(
      diagramSchema.safeParse({
        name: "超长",
        nodes: [{ id: "a", title: "x", body: "x".repeat(1_801) }],
      }).success,
    ).toBe(false);
    expect(() =>
      buildDiagram({
        name: "超大布局",
        layout: "timeline",
        nodes: Array.from({ length: 100 }, (_, i) => ({
          id: `${i}`,
          title: "x",
          body: "x\n".repeat(900),
        })),
      }),
    ).toThrow("布局超出画布坐标上限");
    expect(JSON.stringify(zodSchema()).length).toBeLessThan(4_000);
  });
});

function zodSchema() {
  return z.toJSONSchema(diagramSchema);
}
