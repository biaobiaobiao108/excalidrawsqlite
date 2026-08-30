import type {
  OutlineNode,
  LayoutedNode,
  OutlineLayoutResult,
  OutlineConnection,
} from "./types";

const estimateNodeSize = (
  node: OutlineNode,
): { width: number; height: number } => {
  const textLength = node.text.length;

  if (node.level === 0) {
    const width = Math.max(160, Math.min(380, textLength * 18 + 48));
    const height = Math.max(54, Math.ceil(textLength / 18) * 26 + 24);
    return { width, height };
  }

  if (node.level === 1) {
    const width = Math.max(130, Math.min(320, textLength * 16 + 36));
    const height = Math.max(46, Math.ceil(textLength / 16) * 24 + 18);
    return { width, height };
  }

  // Level 2+
  const width = Math.max(110, Math.min(280, textLength * 14 + 32));
  const height = Math.max(40, Math.ceil(textLength / 16) * 22 + 16);
  return { width, height };
};

type MindmapTreeNode = {
  raw: OutlineNode;
  width: number;
  height: number;
  subtreeHeight: number;
  branchIndex: number;
  children: MindmapTreeNode[];
};

const buildMindmapTree = (
  node: OutlineNode,
  branchIndex: number,
): MindmapTreeNode => {
  const size = estimateNodeSize(node);
  const children = node.children.map((child, idx) =>
    buildMindmapTree(child, node.level === 0 ? idx : branchIndex),
  );

  let childrenHeightSum = 0;
  for (let i = 0; i < children.length; i++) {
    childrenHeightSum += children[i].subtreeHeight;
    if (i > 0) {
      childrenHeightSum += 28; // vertical gap between sibling branches
    }
  }

  const subtreeHeight = Math.max(size.height, childrenHeightSum);

  return {
    raw: node,
    width: size.width,
    height: size.height,
    subtreeHeight,
    branchIndex,
    children,
  };
};

const calculateBoundsAndResult = (
  nodes: LayoutedNode[],
  connections: OutlineConnection[],
): OutlineLayoutResult => {
  if (nodes.length === 0) {
    return {
      nodes: [],
      connections: [],
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }

  return {
    nodes,
    connections,
    bounds: {
      minX,
      minY,
      maxX,
      maxY,
      width: maxX - minX,
      height: maxY - minY,
    },
  };
};

export const layoutMindmap = (root: OutlineNode): OutlineLayoutResult => {
  const tree = buildMindmapTree(root, 0);
  const nodes: LayoutedNode[] = [];
  const connections: OutlineConnection[] = [];

  const positionNode = (
    item: MindmapTreeNode,
    x: number,
    yCenter: number,
    parentId?: string,
  ): LayoutedNode => {
    const y = yCenter - item.height / 2;
    const layouted: LayoutedNode = {
      id: item.raw.id,
      text: item.raw.text,
      level: item.raw.level,
      branchIndex: item.branchIndex,
      x,
      y,
      width: item.width,
      height: item.height,
      parentId,
      children: [],
    };
    nodes.push(layouted);

    if (parentId) {
      connections.push({
        id: `conn_${parentId}_${item.raw.id}`,
        startId: parentId,
        endId: item.raw.id,
        branchIndex: item.branchIndex,
        level: item.raw.level,
      });
    }

    if (item.children.length > 0) {
      const childX = x + item.width + 80; // horizontal gap
      let currentTopY = yCenter - item.subtreeHeight / 2;

      for (const child of item.children) {
        const childCenterY = currentTopY + child.subtreeHeight / 2;
        const childLayouted = positionNode(
          child,
          childX,
          childCenterY,
          item.raw.id,
        );
        layouted.children.push(childLayouted);
        currentTopY += child.subtreeHeight + 28;
      }
    }

    return layouted;
  };

  positionNode(tree, 0, tree.subtreeHeight / 2);

  return calculateBoundsAndResult(nodes, connections);
};

export const layoutOutline = (
  root: OutlineNode,
  _layoutType?: "mindmap",
): OutlineLayoutResult => {
  return layoutMindmap(root);
};
