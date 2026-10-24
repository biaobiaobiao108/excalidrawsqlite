import { describe, expect, it } from "bun:test";
import { buildDiagram, diagramSchema } from "../../server/mcp-diagram";
import {
  assertDiagramRouterCells,
  assertDiagramRouterWork,
  DIAGRAM_ROUTER_CELL_LIMIT,
  DIAGRAM_ROUTER_WORK_LIMIT,
} from "../../server/mcp-diagram-regions";
import {
  createDrawingBatch,
  updateDrawingElements,
} from "../../server/mcp-drawing";
import { inspectLayout } from "../../server/mcp-inspect";
import { copyDrawingSelection } from "../../server/mcp-copy";

const regions = [
  { id: "application", title: "应用层" },
  { id: "frontend", title: "用户与界面", parentId: "application" },
  { id: "backend", title: "业务与服务", parentId: "application" },
  { id: "storage", title: "存储层" },
];
const nodes = [
  {
    id: "a",
    title: "开始",
    body: "中文与 English 混排".repeat(12),
    regionId: "frontend",
  },
  { id: "b", title: "验证", regionId: "backend" },
  { id: "c", title: "持久化", regionId: "storage" },
];
const edges = [
  { from: "a", to: "b" },
  { from: "b", to: "c" },
  { from: "c", to: "a" },
  { from: "b", to: "b" },
];

describe("MCP region diagrams", () => {
  it("builds nested architecture groups and safe long-text bounds in either direction", () => {
    for (const direction of ["horizontal", "vertical"] as const) {
      const result = buildDiagram({
        name: "架构",
        layout: "architecture",
        nodes,
        regions,
        edges,
        direction,
      });
      expect("regions" in result && result.regions.length).toBe(4);
      if (!("bounds" in result)) throw new Error("高级布局必须返回边界");
      for (const connector of result.elements.filter(
        (element) => element.type === "arrow",
      )) {
        expect(connector.points![0]).toEqual([0, 0]);
        for (const point of connector.points!) {
          const x = connector.x! + point[0],
            y = connector.y! + point[1];
          expect(x).toBeGreaterThanOrEqual(result.bounds.x);
          expect(x).toBeLessThanOrEqual(result.bounds.x + result.bounds.width);
          expect(y).toBeGreaterThanOrEqual(result.bounds.y);
          expect(y).toBeLessThanOrEqual(result.bounds.y + result.bounds.height);
        }
      }
      const created = createDrawingBatch(result.elements);
      const diagnostics = inspectLayout(created.elements, {
        checks: ["text_overlap", "text_overflow", "arrow_connection"],
      });
      expect(diagnostics.issues).toEqual([]);
      expect(diagnostics.complete).toBe(true);
      const node = created.elements.find((element) => element.id === "a")!;
      expect(node.groupIds.length).toBe(2);
      const label = created.elements.find(
        (element) => element.id === "a:label",
      )!;
      expect(label.groupIds).toEqual(node.groupIds);
      const root =
        "regions" in result
          ? result.regions.find((region) => region.regionId === "application")!
          : null;
      expect(root!.elementIds).toContain("a:label");
      const arrow = created.elements.find(
        (element) => element.type === "arrow",
      )!;
      expect(arrow.groupIds).toEqual([]);
      const moved = updateDrawingElements(created.elements, [
        { id: "b", dx: 90, dy: 80 },
      ]);
      expect(
        moved.elements.find((element) => element.id === arrow.id),
      ).not.toEqual(arrow);
      const copied = copyDrawingSelection(
        created.elements,
        created.elements.map((element) => element.id),
        [],
        4000,
        0,
        false,
      );
      expect(Object.keys(copied.groupIdMap).length).toBe(8);
    }
  });

  it("aligns shared ranks across lanes, leaves omitted edges empty, and supports cycles", () => {
    const lanes = [
      { id: "front", title: "前端" },
      { id: "back", title: "后端" },
    ];
    const laneNodes = [
      { id: "a", title: "输入", regionId: "front" },
      { id: "b", title: "服务", regionId: "back" },
      { id: "c", title: "展示", regionId: "front" },
      { id: "d", title: "审计", regionId: "back" },
    ];
    for (const direction of ["horizontal", "vertical"] as const) {
      const result = buildDiagram({
        name: "泳道",
        layout: "swimlane",
        regions: lanes,
        nodes: laneNodes,
        direction,
        edges: [
          { from: "a", to: "b" },
          { from: "a", to: "c" },
          { from: "b", to: "d" },
        ],
      });
      const native = createDrawingBatch(result.elements).elements;
      const b = native.find((element) => element.id === "b")!,
        c = native.find((element) => element.id === "c")!;
      expect(direction === "horizontal" ? b.x : b.y).toBe(
        direction === "horizontal" ? c.x : c.y,
      );
      expect(
        inspectLayout(native, {
          checks: ["text_overlap", "text_overflow", "arrow_connection"],
        }).issues,
      ).toEqual([]);
      expect(() =>
        buildDiagram({
          name: "循环",
          layout: "swimlane",
          regions: lanes,
          nodes: laneNodes,
          direction,
          edges: [
            { from: "a", to: "b" },
            { from: "b", to: "a" },
            { from: "d", to: "d" },
          ],
        }),
      ).not.toThrow();
    }
    const plain = buildDiagram({
      name: "泳道",
      layout: "swimlane",
      regions: lanes,
      nodes: laneNodes,
    });
    expect(plain.direction).toBe("horizontal");
    expect(plain.edgeCount).toBe(0);
  });

  it("rejects invalid region topology and assignments before scene creation", () => {
    const input = {
      name: "架构",
      layout: "architecture" as const,
      nodes,
      regions,
    };
    expect(() => buildDiagram({ ...input, regions: undefined })).toThrow(
      "必须提供",
    );
    expect(() =>
      buildDiagram({ ...input, regions: [...regions, regions[0]] }),
    ).toThrow("必须唯一");
    expect(() =>
      buildDiagram({ ...input, nodes: [{ ...nodes[0], regionId: "missing" }] }),
    ).toThrow("有效叶区域");
    expect(() =>
      buildDiagram({
        ...input,
        nodes: [{ ...nodes[0], regionId: "application" }],
      }),
    ).toThrow("有效叶区域");
    expect(() =>
      buildDiagram({
        ...input,
        regions: [...regions, { id: "unused", title: "空" }],
      }),
    ).toThrow("没有节点");
    expect(() =>
      buildDiagram({
        ...input,
        regions: [
          { id: "frontend", title: "循环", parentId: "backend" },
          { id: "backend", title: "循环", parentId: "frontend" },
        ],
      }),
    ).toThrow("循环");
    expect(() => buildDiagram({ ...input, layout: "swimlane" })).toThrow(
      "嵌套",
    );
    expect(() =>
      buildDiagram({
        ...input,
        regions: [
          ...regions,
          { id: "third", title: "三级", parentId: "frontend" },
        ],
      }),
    ).toThrow("两级");
    expect(() =>
      buildDiagram({ ...input, edges: [{ from: "a", to: "missing" }] }),
    ).toThrow("不存在");
    expect(
      diagramSchema.safeParse({
        ...input,
        regions: Array.from({ length: 25 }, (_, index) => ({
          id: String(index),
          title: "区域",
        })),
      }).success,
    ).toBe(false);
  });

  it("routes the maximum supported graph without unbounded work", () => {
    const manyNodes = Array.from({ length: 100 }, (_, index) => ({
      id: `n${index}`,
      title: "节点",
      regionId: `r${index % 4}`,
    }));
    const manyEdges = Array.from({ length: 200 }, (_, index) => ({
      from: `n${index % 100}`,
      to: `n${((index % 100) + (index < 100 ? 1 : 2)) % 100}`,
    }));
    const result = buildDiagram({
      name: "最大图",
      layout: "swimlane",
      nodes: manyNodes,
      edges: manyEdges,
      regions: Array.from({ length: 4 }, (_, index) => ({
        id: `r${index}`,
        title: "区域",
      })),
    });
    expect(result.nodeCount).toBe(100);
    expect(result.edgeCount).toBe(200);
    expect(createDrawingBatch(result.elements).elements.length).toBe(408);
  });

  it("accepts the routing work budget boundary and rejects work above it", () => {
    expect(() =>
      assertDiagramRouterCells(DIAGRAM_ROUTER_CELL_LIMIT),
    ).not.toThrow();
    expect(() =>
      assertDiagramRouterCells(DIAGRAM_ROUTER_CELL_LIMIT + 1),
    ).toThrow("网格超过容量上限");
    expect(() =>
      assertDiagramRouterWork(DIAGRAM_ROUTER_WORK_LIMIT),
    ).not.toThrow();
    expect(() =>
      assertDiagramRouterWork(DIAGRAM_ROUTER_WORK_LIMIT + 1),
    ).toThrow("预计工作量超过上限");
  });

  it("rejects the maximum node, edge, and region combination when routing exceeds its budget", () => {
    const manyNodes = Array.from({ length: 100 }, (_, index) => ({
      id: `n${index}`,
      title: "节点",
      regionId: `r${index % 24}`,
    }));
    const manyEdges = [
      ...Array.from({ length: 99 }, (_, index) => ({
        from: `n${index}`,
        to: `n${index + 1}`,
      })),
      ...Array.from({ length: 98 }, (_, index) => ({
        from: `n${index}`,
        to: `n${index + 2}`,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        from: `n${index}`,
        to: `n${index + 3}`,
      })),
    ];
    const manyRegions = Array.from({ length: 24 }, (_, index) => ({
      id: `r${index}`,
      title: "区域",
    }));
    let error: unknown;
    try {
      buildDiagram({
        name: "预算边界",
        layout: "swimlane",
        nodes: manyNodes,
        edges: manyEdges,
        regions: manyRegions,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "DIAGRAM_ROUTING_LIMIT" });
  });
});
