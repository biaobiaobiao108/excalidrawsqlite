import type { z } from "zod/v4";
import type { Diagram } from "./mcp-diagram";
import { drawingElementSchema, measureDrawingText } from "./mcp-drawing";
import { HttpError } from "./errors";

type Spec = z.infer<typeof drawingElementSchema>;
type Bounds = { x: number; y: number; width: number; height: number };
type Point = [number, number];
type Region = NonNullable<Diagram["regions"]>[number];
const padding = 32,
  gap = 80,
  nodeWidth = 320;
export const DIAGRAM_ROUTER_CELL_LIMIT = 100_000;
export const DIAGRAM_ROUTER_WORK_LIMIT = 20_000_000;
const ROUTER_SEARCH_WORK_PER_CELL = 8;

export const assertDiagramRouterCells = (cells: number) => {
  if (
    !Number.isSafeInteger(cells) ||
    cells < 0 ||
    cells > DIAGRAM_ROUTER_CELL_LIMIT
  )
    throw new HttpError(
      400,
      "DIAGRAM_ROUTING_LIMIT",
      "连线路由网格超过容量上限，请减少节点、区域或连接数量",
    );
};

export const assertDiagramRouterWork = (work: number) => {
  if (
    !Number.isSafeInteger(work) ||
    work < 0 ||
    work > DIAGRAM_ROUTER_WORK_LIMIT
  )
    throw new HttpError(
      400,
      "DIAGRAM_ROUTING_LIMIT",
      "连线路由预计工作量超过上限，请减少节点、区域或连接数量",
    );
};

export const buildRegionDiagram = (
  args: Diagram,
  cards: Spec[],
  heights: number[],
  ranks: Map<string, number>,
  edges: NonNullable<Diagram["edges"]>,
  style: { strokeColor: string; backgroundColor: string },
) => {
  const regions = args.regions ?? [];
  const fail = (message: string): never => {
    throw new HttpError(400, "INVALID_DIAGRAM_REGION", message);
  };
  if (!regions.length) fail("高级布局必须提供 regions");
  const byId = new Map(regions.map((region) => [region.id, region]));
  if (byId.size !== regions.length) fail("regions.id 必须唯一");
  const children = new Map(
    regions.map((region) => [region.id, [] as Region[]]),
  );
  for (const region of regions) {
    if (!region.parentId) continue;
    const parent = byId.get(region.parentId);
    if (!parent || parent.id === region.id || parent.parentId)
      fail("区域父级不存在、存在循环或超过两级");
    if (args.layout === "swimlane") fail("swimlane 不接受嵌套区域");
    children.get(parent!.id)!.push(region);
  }
  const members = new Map(regions.map((region) => [region.id, [] as number[]]));
  args.nodes.forEach((node, index) => {
    if (
      !node.regionId ||
      !byId.has(node.regionId) ||
      children.get(node.regionId)!.length
    )
      fail(`节点 ${node.id} 必须引用有效叶区域`);
    members.get(node.regionId!)!.push(index);
  });
  for (const region of regions)
    if (!children.get(region.id)!.length && !members.get(region.id)!.length)
      fail(`区域 ${region.id} 没有节点`);
  const direction =
    args.direction ?? (args.layout === "swimlane" ? "horizontal" : "vertical");
  const vertical = direction === "vertical";
  const usedIds = new Set(args.nodes.map((node) => node.id));
  const allocate = (base: string) => {
    const prefix = base.slice(0, 72);
    let candidate = prefix,
      suffix = 0;
    while (usedIds.has(candidate)) candidate = `${prefix}_${++suffix}`;
    usedIds.add(candidate);
    return candidate;
  };
  const groups = new Map(
    regions.map((region, index) => [
      region.id,
      allocate(`diagram_region_group_${index}`),
    ]),
  );
  const groupIds = (region: Region) => [
    groups.get(region.id)!,
    ...(region.parentId ? [groups.get(region.parentId)!] : []),
  ];
  const regionBoxes = new Map<string, Bounds>();
  const nodeBoxes = new Map<string, Bounds>();
  const titleHeights = new Map<string, number>();
  const titleHeight = (region: Region, width: number) => {
    const measured = measureDrawingText({
      text: region.title,
      fontSize: 24,
      fontFamily: "system",
      width: width - padding * 2,
    });
    titleHeights.set(region.id, measured.height);
    return measured.height;
  };
  const localNodes = new Map<string, Bounds>();
  const sizes = new Map<string, Bounds>();
  if (args.layout === "architecture") {
    for (const region of regions.filter(
      (item) => !children.get(item.id)!.length,
    )) {
      const indices = members.get(region.id)!;
      const columns = Math.min(3, indices.length);
      const width = padding * 2 + columns * nodeWidth + (columns - 1) * gap;
      let rowY = padding + titleHeight(region, width) + padding;
      for (let offset = 0; offset < indices.length; offset += columns) {
        const row = indices.slice(offset, offset + columns);
        const rowHeight = Math.max(...row.map((index) => heights[index]));
        row.forEach((index, column) =>
          localNodes.set(args.nodes[index].id, {
            x: padding + column * (nodeWidth + gap),
            y: rowY,
            width: nodeWidth,
            height: heights[index],
          }),
        );
        rowY += rowHeight + gap;
      }
      sizes.set(region.id, { x: 0, y: 0, width, height: rowY - gap + padding });
    }
    for (const parent of regions.filter(
      (region) => children.get(region.id)!.length,
    )) {
      const nested = children.get(parent.id)!,
        boxes = nested.map((region) => sizes.get(region.id)!);
      const width =
        padding * 2 +
        (vertical
          ? boxes.reduce((total, box) => total + box.width, 0) +
            (boxes.length - 1) * gap
          : Math.max(...boxes.map((box) => box.width)));
      const header = padding + titleHeight(parent, width) + padding;
      const height =
        header +
        padding +
        (vertical
          ? Math.max(...boxes.map((box) => box.height))
          : boxes.reduce((total, box) => total + box.height, 0) +
            (boxes.length - 1) * gap);
      sizes.set(parent.id, { x: 0, y: 0, width, height });
      let cross = vertical ? padding : header;
      nested.forEach((region) => {
        const size = sizes.get(region.id)!;
        size.x = vertical ? cross : padding;
        size.y = vertical ? header : cross;
        cross += (vertical ? size.width : size.height) + gap;
      });
    }
    let main = 80;
    for (const root of regions.filter((region) => !region.parentId)) {
      const size = sizes.get(root.id)!;
      const rootBox = {
        ...size,
        x: vertical ? 80 : main,
        y: vertical ? main : 80,
      };
      regionBoxes.set(root.id, rootBox);
      main += (vertical ? size.height : size.width) + gap;
      for (const child of children.get(root.id)!) {
        const childSize = sizes.get(child.id)!;
        regionBoxes.set(child.id, {
          ...childSize,
          x: rootBox.x + childSize.x,
          y: rootBox.y + childSize.y,
        });
      }
    }
    for (const node of args.nodes) {
      const box = regionBoxes.get(node.regionId!)!,
        local = localNodes.get(node.id)!;
      nodeBoxes.set(node.id, {
        ...local,
        x: box.x + local.x,
        y: box.y + local.y,
      });
    }
  } else {
    const height = Math.max(...heights);
    const maxRank = Math.max(...ranks.values());
    const mainSize = vertical ? height : nodeWidth;
    const crossSize = vertical ? nodeWidth : height;
    let crossOrigin = 80;
    const maxTitle = Math.max(
      ...regions.map((region) =>
        titleHeight(
          region,
          vertical
            ? padding * 2 + nodeWidth
            : padding * 2 + (maxRank + 1) * (mainSize + gap) - gap,
        ),
      ),
    );
    const header = padding + maxTitle + padding;
    for (const region of regions) {
      const rows = new Map<number, number[]>();
      for (const index of members.get(region.id)!) {
        const rank = ranks.get(args.nodes[index].id)!;
        if (!rows.has(rank)) rows.set(rank, []);
        rows.get(rank)!.push(index);
      }
      const slots = Math.max(...[...rows.values()].map((row) => row.length));
      const crossExtent = slots * (crossSize + gap) - gap;
      const mainExtent = (maxRank + 1) * (mainSize + gap) - gap;
      const box = {
        x: vertical ? crossOrigin : 80,
        y: vertical ? 80 : crossOrigin,
        width: padding * 2 + (vertical ? crossExtent : mainExtent),
        height: header + padding + (vertical ? mainExtent : crossExtent),
      };
      regionBoxes.set(region.id, box);
      titleHeight(region, box.width);
      for (const [rank, indices] of rows)
        indices.forEach((index, slot) => {
          const main = rank * (mainSize + gap),
            cross = slot * (crossSize + gap);
          nodeBoxes.set(args.nodes[index].id, {
            x: box.x + padding + (vertical ? cross : main),
            y: box.y + header + (vertical ? main : cross),
            width: nodeWidth,
            height: heights[index],
          });
        });
      crossOrigin += (vertical ? box.width : box.height) + gap;
    }
  }
  const elements: Spec[] = [];
  const receipts = [...regions]
    .sort(
      (first, second) => Number(!!first.parentId) - Number(!!second.parentId),
    )
    .map((region, index) => {
      const box = regionBoxes.get(region.id)!;
      const backgroundId = allocate(`diagram_region_${index}`),
        titleId = allocate(`diagram_region_title_${index}`);
      const headerGroups = [
        allocate(`diagram_region_header_group_${index}`),
        ...groupIds(region),
      ];
      elements.push(
        drawingElementSchema.parse({
          type: "rectangle",
          id: backgroundId,
          ...box,
          ...style,
          fillStyle: "solid",
          roughness: 0,
          roundness: 12,
          groupIds: headerGroups,
        }),
      );
      elements.push(
        drawingElementSchema.parse({
          type: "text",
          id: titleId,
          text: region.title,
          x: box.x + padding,
          y: box.y + padding,
          width: box.width - padding * 2,
          fontSize: 24,
          fontFamily: "system",
          strokeColor: style.strokeColor,
          groupIds: headerGroups,
        }),
      );
      const descendants = args.nodes
        .filter(
          (node) =>
            node.regionId === region.id ||
            byId.get(node.regionId!)?.parentId === region.id,
        )
        .map((node) => node.id);
      return {
        regionId: region.id,
        backgroundId,
        titleId,
        groupId: groups.get(region.id)!,
        nodeIds: descendants,
        elementIds: [backgroundId, titleId, ...descendants],
        bounds: box,
      };
    });
  const labels = new Map(
    args.nodes.map((node) => [node.id, allocate(`${node.id}:label`)]),
  );
  args.nodes.forEach((node, index) =>
    elements.push(
      drawingElementSchema.parse({
        ...cards[index],
        ...nodeBoxes.get(node.id)!,
        labelId: labels.get(node.id),
        groupIds: groupIds(byId.get(node.regionId!)!),
      }),
    ),
  );
  const obstacles = [
    ...nodeBoxes.values(),
    ...regions.map((region) => {
      const box = regionBoxes.get(region.id)!;
      return {
        x: box.x + padding,
        y: box.y + padding,
        width: box.width - padding * 2,
        height: titleHeights.get(region.id)!,
      };
    }),
  ];
  const endpoints = edges.map((edge) => {
    const from = nodeBoxes.get(edge.from)!,
      to = nodeBoxes.get(edge.to)!;
    const start: Point = vertical
      ? [from.x + from.width / 2, from.y + from.height]
      : [from.x + from.width, from.y + from.height / 2];
    const end: Point = vertical
      ? [to.x + to.width / 2, to.y]
      : [to.x, to.y + to.height / 2];
    const startPort: Point = vertical
      ? [start[0], start[1] + 20]
      : [start[0] + 20, start[1]];
    const endPort: Point = vertical
      ? [end[0], end[1] - 20]
      : [end[0] - 20, end[1]];
    return { edge, start, end, startPort, endPort };
  });
  const route = makeRouter(
    obstacles,
    endpoints.flatMap((item) => [item.startPort, item.endPort]),
    endpoints.length,
  );
  endpoints.forEach(({ edge, start, end, startPort, endPort }, index) => {
    const points = [start, ...route(startPort, endPort), end];
    const fromRegion = byId.get(
      args.nodes.find((node) => node.id === edge.from)!.regionId!,
    )!;
    const sameRegion =
      args.nodes.find((node) => node.id === edge.to)!.regionId ===
      fromRegion.id;
    const id = allocate(`diagram_edge_${index}`);
    elements.push(
      drawingElementSchema.parse({
        type: "arrow",
        id,
        x: start[0],
        y: start[1],
        points: points.map((point) => [
          point[0] - start[0],
          point[1] - start[1],
        ]),
        strokeColor: style.strokeColor,
        roughness: 0,
        groupIds: sameRegion ? groupIds(fromRegion) : [],
        startBinding: {
          elementId: edge.from,
          fixedPoint: vertical ? [0.5, 1] : [1, 0.5],
        },
        endBinding: {
          elementId: edge.to,
          fixedPoint: vertical ? [0.5, 0] : [0, 0.5],
        },
        endArrowhead:
          edge.endArrowhead === undefined ? "arrow" : edge.endArrowhead,
      }),
    );
    if (sameRegion)
      receipts
        .filter(
          (receipt) =>
            receipt.regionId === fromRegion.id ||
            receipt.regionId === fromRegion.parentId,
        )
        .forEach((receipt) => receipt.elementIds.push(id));
  });
  for (const receipt of receipts) {
    const descendantRegions = receipts.filter(
      (other) => byId.get(other.regionId)?.parentId === receipt.regionId,
    );
    receipt.elementIds.push(
      ...descendantRegions.flatMap((other) => [
        other.backgroundId,
        other.titleId,
      ]),
    );
    receipt.elementIds.push(...receipt.nodeIds.map((id) => labels.get(id)!));
  }
  const pointBounds = [...regionBoxes.values()].flatMap((box) => [
    [box.x, box.y],
    [box.x + box.width, box.y + box.height],
  ]);
  for (const element of elements)
    if (element.type === "arrow")
      pointBounds.push(
        ...element.points!.map((point) => [
          element.x! + point[0],
          element.y! + point[1],
        ]),
      );
  const left = Math.min(...pointBounds.map((point) => point[0])),
    top = Math.min(...pointBounds.map((point) => point[1]));
  const right = Math.max(...pointBounds.map((point) => point[0])),
    bottom = Math.max(...pointBounds.map((point) => point[1]));
  if (
    ![left, top, right, bottom].every(
      (value) => Number.isFinite(value) && Math.abs(value) <= 1_000_000,
    )
  )
    throw new HttpError(
      400,
      "DIAGRAM_TOO_LARGE",
      "布局超出画布坐标上限，请减少节点数量或标签换行",
    );
  return {
    elements,
    nodeCount: args.nodes.length,
    edgeCount: edges.length,
    layout: args.layout!,
    direction,
    theme: args.theme ?? "forest",
    regions: receipts,
    bounds: { x: left, y: top, width: right - left, height: bottom - top },
    estimated: true,
    nodeRegions: args.nodes.map((node) => ({
      nodeId: node.id,
      regionId: node.regionId!,
    })),
  };
};

const makeRouter = (
  obstacles: Bounds[],
  ports: Point[],
  routeCount: number,
) => {
  const boxes = obstacles.map((box) => ({
    x: box.x - 10,
    y: box.y - 10,
    width: box.width + 20,
    height: box.height + 20,
  }));
  const xs = [
    ...new Set([
      ...boxes.flatMap((box) => [box.x - 10, box.x + box.width + 10]),
      ...ports.map((point) => point[0]),
    ]),
  ].sort((first, second) => first - second);
  const ys = [
    ...new Set([
      ...boxes.flatMap((box) => [box.y - 10, box.y + box.height + 10]),
      ...ports.map((point) => point[1]),
    ]),
  ].sort((first, second) => first - second);
  const columns = xs.length,
    count = columns * ys.length;
  assertDiagramRouterCells(count);
  const gridEdges =
    columns * Math.max(0, ys.length - 1) + ys.length * Math.max(0, columns - 1);
  // Bound the worst case before allocating the grid: each grid edge can inspect
  // every obstacle, and each route can visit every cell while scanning neighbors.
  assertDiagramRouterWork(
    gridEdges * boxes.length + count * routeCount * ROUTER_SEARCH_WORK_PER_CELL,
  );
  const horizontal = new Uint8Array(count),
    downward = new Uint8Array(count);
  const clear = (start: Point, end: Point) =>
    !boxes.some((box) =>
      start[1] === end[1]
        ? start[1] > box.y &&
          start[1] < box.y + box.height &&
          Math.max(start[0], end[0]) > box.x &&
          Math.min(start[0], end[0]) < box.x + box.width
        : start[0] > box.x &&
          start[0] < box.x + box.width &&
          Math.max(start[1], end[1]) > box.y &&
          Math.min(start[1], end[1]) < box.y + box.height,
    );
  for (let row = 0; row < ys.length; row++)
    for (let column = 0; column < columns; column++) {
      const index = row * columns + column;
      if (
        column + 1 < columns &&
        clear([xs[column], ys[row]], [xs[column + 1], ys[row]])
      )
        horizontal[index] = 1;
      if (
        row + 1 < ys.length &&
        clear([xs[column], ys[row]], [xs[column], ys[row + 1]])
      )
        downward[index] = 1;
    }
  return (start: Point, end: Point): Point[] => {
    const origin = ys.indexOf(start[1]) * columns + xs.indexOf(start[0]);
    const target = ys.indexOf(end[1]) * columns + xs.indexOf(end[0]);
    const previous = new Int32Array(count).fill(-1),
      seen = new Uint8Array(count);
    const queue = new Int32Array(count);
    queue[0] = origin;
    seen[origin] = 1;
    let length = 1;
    for (let offset = 0; offset < length && !seen[target]; offset++) {
      const current = queue[offset],
        row = Math.floor(current / columns),
        column = current % columns;
      const next = [
        column + 1 < columns && horizontal[current] ? current + 1 : -1,
        row + 1 < ys.length && downward[current] ? current + columns : -1,
        column > 0 && horizontal[current - 1] ? current - 1 : -1,
        row > 0 && downward[current - columns] ? current - columns : -1,
      ];
      next.sort((first, second) =>
        first < 0
          ? 1
          : second < 0
            ? -1
            : Math.abs(xs[first % columns] - end[0]) +
              Math.abs(ys[Math.floor(first / columns)] - end[1]) -
              Math.abs(xs[second % columns] - end[0]) -
              Math.abs(ys[Math.floor(second / columns)] - end[1]),
      );
      for (const neighbor of next)
        if (neighbor >= 0 && !seen[neighbor]) {
          previous[neighbor] = current;
          seen[neighbor] = 1;
          queue[length++] = neighbor;
        }
    }
    if (!seen[target])
      throw new HttpError(
        400,
        "DIAGRAM_ROUTING_FAILED",
        "无法在节点与标题之间找到安全连线路径",
      );
    const path: Point[] = [];
    for (let current = target; current >= 0; current = previous[current]) {
      path.push([xs[current % columns], ys[Math.floor(current / columns)]]);
      if (current === origin) break;
    }
    path.reverse();
    return path.filter(
      (point, index) =>
        !index ||
        index === path.length - 1 ||
        !(
          (path[index - 1][0] === point[0] &&
            point[0] === path[index + 1][0]) ||
          (path[index - 1][1] === point[1] && point[1] === path[index + 1][1])
        ),
    );
  };
};
