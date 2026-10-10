import * as z from "zod/v4";
import { HttpError } from "./errors";
import { createDrawingElements, drawingElementSchema } from "./mcp-drawing";

const nodeId = z.string().trim().min(1).max(80);
export const diagramSchema = z.object({
  name: z.string().trim().min(1).max(120),
  layout: z.enum(["timeline", "flowchart"]).optional().describe("timeline 按节点顺序；flowchart 按连接分层，支持分支和循环"),
  direction: z.enum(["vertical", "horizontal"]).optional(),
  theme: z.enum(["forest", "paper", "ocean"]).optional(),
  nodes: z.array(z.object({
    id: nodeId.describe("画板内的稳定图元 ID，供 edges 和后续更新引用"),
    title: z.string().trim().min(1).max(120),
    body: z.string().max(1_800).optional(),
  }).strict()).min(1).max(100),
  edges: z.array(z.object({ from: nodeId, to: nodeId }).strict()).max(200)
    .optional().describe("省略则按节点顺序连接；[] 表示无连线，可包含分支、回路与自连接"),
}).strict();

type Diagram = z.infer<typeof diagramSchema>;
type Spec = z.infer<typeof drawingElementSchema>;
type Point = [number, number];
type Box = { x: number; y: number; width: number; height: number; rank: number };

const themes = {
  forest: { strokeColor: "#38634d", backgroundColor: "#eef5ef" },
  paper: { strokeColor: "#424242", backgroundColor: "#fff9eb" },
  ocean: { strokeColor: "#315b83", backgroundColor: "#edf5fc" },
} as const;

// Condense strongly connected components before ranking. Cycles remain usable
// rather than making topological ordering fail or iterating indefinitely.
const flowRanks = (ids: string[], edges: Diagram["edges"]): Map<string, number> => {
  const adjacency = new Map(ids.map((id) => [id, [] as string[]]));
  for (const edge of edges || []) adjacency.get(edge.from)!.push(edge.to);
  let nextIndex = 0;
  const indices = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], active = new Set<string>(), components: string[][] = [];
  const visit = (id: string) => {
    indices.set(id, nextIndex);
    low.set(id, nextIndex++);
    stack.push(id);
    active.add(id);
    for (const target of adjacency.get(id)!) {
      if (!indices.has(target)) {
        visit(target);
        low.set(id, Math.min(low.get(id)!, low.get(target)!));
      } else if (active.has(target)) {
        low.set(id, Math.min(low.get(id)!, indices.get(target)!));
      }
    }
    if (low.get(id) === indices.get(id)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        active.delete(member);
        component.push(member);
      } while (member !== id);
      components.push(component);
    }
  };
  for (const id of ids) if (!indices.has(id)) visit(id);
  const membership = new Map<string, number>();
  components.forEach((members, index) => members.forEach((id) => membership.set(id, index)));
  const outgoing = components.map(() => new Set<number>());
  const indegree = components.map(() => 0), ranks = components.map(() => 0);
  for (const { from, to } of edges || []) {
    const a = membership.get(from)!, b = membership.get(to)!;
    if (a !== b && !outgoing[a].has(b)) {
      outgoing[a].add(b);
      indegree[b]++;
    }
  }
  const queue = indegree.flatMap((degree, index) => degree === 0 ? [index] : []);
  for (let offset = 0; offset < queue.length; offset++) {
    const index = queue[offset];
    for (const target of outgoing[index]) {
      ranks[target] = Math.max(ranks[target], ranks[index] + 1);
      if (--indegree[target] === 0) queue.push(target);
    }
  }
  return new Map(ids.map((id) => [id, ranks[membership.get(id)!]]));
};

/** Produce bounded standard writable specs; persistence is handled by create_board. */
export const buildDiagram = (input: Diagram) => {
  const args = diagramSchema.parse({ name: input.name, layout: input.layout,
    direction: input.direction, theme: input.theme, nodes: input.nodes, edges: input.edges });
  const layout = args.layout ?? "flowchart", direction = args.direction ?? "vertical";
  const theme = args.theme ?? "forest", style = themes[theme];
  const ids = args.nodes.map((node) => node.id), unique = new Set(ids);
  if (unique.size !== ids.length)
    throw new HttpError(400, "DUPLICATE_NODE_ID", "nodes.id 必须唯一");
  const edges = args.edges ?? ids.slice(1).map((to, index) => ({ from: ids[index], to }));
  const connections = new Set<string>();
  for (const edge of edges) {
    if (!unique.has(edge.from) || !unique.has(edge.to))
      throw new HttpError(400, "INVALID_DIAGRAM_EDGE", `连接目标不存在：${edge.from} → ${edge.to}`);
    const key = JSON.stringify([edge.from, edge.to]);
    if (connections.has(key))
      throw new HttpError(400, "DUPLICATE_DIAGRAM_EDGE", `重复连接：${edge.from} → ${edge.to}`);
    connections.add(key);
  }
  const ranks = layout === "timeline"
    ? new Map(ids.map((id, index) => [id, index]))
    : flowRanks(ids, edges);
  const width = 320;
  // Measure using the exact same wrapping/metrics as the normal MCP writer.
  // This avoids guesses about Chinese, long words, or explicit line breaks.
  const cards: Spec[] = args.nodes.map((node) => drawingElementSchema.parse({
    type: "rectangle", id: node.id, x: 0, y: 0, width, height: 100,
    text: node.body ? `${node.title}\n\n${node.body}` : node.title,
    fontSize: 18, fontFamily: "system", textAlign: "left",
    ...style, fillStyle: "solid", roughness: 0, roundness: 12,
  }));
  const heights = cards.map((card) => {
    const label = createDrawingElements(card).find((element) => element.type === "text");
    return Math.max(100, Math.ceil((label?.height ?? 0) + 48));
  });
  const height = Math.max(...heights), mainSize = direction === "vertical" ? height : width;
  const crossSize = direction === "vertical" ? width : height;
  const rows = new Map<number, string[]>();
  for (const id of ids) {
    const rank = ranks.get(id)!;
    if (!rows.has(rank)) rows.set(rank, []);
    rows.get(rank)!.push(id);
  }
  const lanes = Math.max(...[...rows.values()].map((row) => row.length));
  const crossExtent = lanes * (crossSize + 80) - 80;
  const mainExtent = 80 + Math.max(...ranks.values()) * (mainSize + 120) + mainSize;
  if (mainExtent > 1_000_000 || 80 + crossExtent + 48 + edges.length * 20 > 1_000_000)
    throw new HttpError(400, "DIAGRAM_TOO_LARGE", "布局超出画布坐标上限，请减少节点数量或标签换行");
  const boxes = new Map<string, Box>();
  for (const [rank, members] of rows) {
    const rowExtent = members.length * (crossSize + 80) - 80;
    members.forEach((id, lane) => {
      const main = 80 + rank * (mainSize + 120);
      const cross = 80 + (crossExtent - rowExtent) / 2 + lane * (crossSize + 80);
      boxes.set(id, { x: direction === "vertical" ? cross : main,
        y: direction === "vertical" ? main : cross, width, height, rank });
    });
  }
  const elements: Spec[] = cards.map((card) => {
    const { x, y } = boxes.get(card.id!)!;
    return drawingElementSchema.parse({ ...card, x, y, height });
  });
  const usedIds = new Set(ids);
  const allocateId = (index: number) => {
    let id = `diagram_edge_${index}`, suffix = 0;
    while (usedIds.has(id)) id = `diagram_edge_${index}_${++suffix}`;
    usedIds.add(id);
    return id;
  };
  edges.forEach((edge, index) => {
    const from = boxes.get(edge.from)!, to = boxes.get(edge.to)!;
    const vertical = direction === "vertical";
    const start: Point = vertical ? [from.x + width / 2, from.y + height]
      : [from.x + width, from.y + height / 2];
    const end: Point = vertical ? [to.x + width / 2, to.y]
      : [to.x, to.y + height / 2];
    let points: Point[];
    const startFixed: Point = vertical ? [0.5, 1] : [1, 0.5];
    const endFixed: Point = vertical ? [0.5, 0] : [0, 0.5];
    if (to.rank === from.rank + 1) {
      const midpoint = vertical ? (start[1] + end[1]) / 2 : (start[0] + end[0]) / 2;
      points = vertical ? [start, [start[0], midpoint], [end[0], midpoint], end]
        : [start, [midpoint, start[1]], [midpoint, end[1]], end];
    } else {
      // Loops, back-edges and skipped ranks use an exterior channel, keeping
      // the long segment outside every card instead of running through nodes.
      const exterior = 80 + crossExtent + 48 + index * 20;
      points = vertical
        ? [start, [start[0], start[1] + 40], [exterior, start[1] + 40],
            [exterior, end[1] - 40], [end[0], end[1] - 40], end]
        : [start, [start[0] + 40, start[1]], [start[0] + 40, exterior],
            [end[0] - 40, exterior], [end[0] - 40, end[1]], end];
    }
    // Remove consecutive duplicate corners, preserving meaningful turns.
    points = points.filter((point, i) => !i || point[0] !== points[i - 1][0] || point[1] !== points[i - 1][1]);
    elements.push(drawingElementSchema.parse({ type: "arrow", id: allocateId(index), points,
      startBinding: { elementId: edge.from, fixedPoint: startFixed },
      endBinding: { elementId: edge.to, fixedPoint: endFixed },
      strokeColor: style.strokeColor, roughness: 0, endArrowhead: "arrow" }));
  });
  return { elements, nodeCount: ids.length, edgeCount: edges.length, layout, direction, theme };
};
