import type {
  OutlineNode,
  LayoutedNode,
  OutlineLayoutResult,
  OutlineLayoutType,
} from "./types";

const estimateNodeSize = (
  node: OutlineNode,
  layoutType: OutlineLayoutType,
): { width: number; height: number } => {
  const textLength = node.text.length;

  if (layoutType === "storyboard") {
    if (node.level === 0) {
      return {
        width: Math.max(200, Math.min(480, textLength * 18 + 40)),
        height: 56,
      };
    }
    if (node.level === 1) {
      return {
        width: 320,
        height: 48,
      };
    }
    return {
      width: 280,
      height: Math.max(40, Math.ceil(textLength / 16) * 22 + 16),
    };
  }

  // Mindmap & Hierarchy
  if (node.level === 0) {
    const width = Math.max(160, Math.min(360, textLength * 18 + 48));
    const height = Math.max(52, Math.ceil(textLength / 18) * 26 + 22);
    return { width, height };
  }

  if (node.level === 1) {
    const width = Math.max(130, Math.min(300, textLength * 16 + 36));
    const height = Math.max(44, Math.ceil(textLength / 16) * 24 + 18);
    return { width, height };
  }

  // Level 2+
  const width = Math.max(110, Math.min(260, textLength * 14 + 32));
  const height = Math.max(38, Math.ceil(textLength / 16) * 22 + 16);
  return { width, height };
};

// ==========================================
// 1. Horizontal Mindmap Layout
// ==========================================
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
  const size = estimateNodeSize(node, "mindmap");
  const children = node.children.map((child, idx) =>
    buildMindmapTree(child, node.level === 0 ? idx : branchIndex),
  );

  let childrenHeightSum = 0;
  for (let i = 0; i < children.length; i++) {
    childrenHeightSum += children[i].subtreeHeight;
    if (i > 0) {
      childrenHeightSum += 24; // vertical gap
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

export const layoutMindmap = (root: OutlineNode): OutlineLayoutResult => {
  const tree = buildMindmapTree(root, 0);
  const nodes: LayoutedNode[] = [];
  const connections: OutlineLayoutResult["connections"] = [];

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
        style: "curved",
      });
    }

    if (item.children.length > 0) {
      const childX = x + item.width + 72; // horizontal gap
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
        currentTopY += child.subtreeHeight + 24;
      }
    }

    return layouted;
  };

  positionNode(tree, 0, tree.subtreeHeight / 2);

  return calculateBoundsAndResult(nodes, connections);
};

// ==========================================
// 2. Vertical Hierarchy Tree Layout
// ==========================================
type HierarchyTreeNode = {
  raw: OutlineNode;
  width: number;
  height: number;
  subtreeWidth: number;
  branchIndex: number;
  children: HierarchyTreeNode[];
};

const buildHierarchyTree = (
  node: OutlineNode,
  branchIndex: number,
): HierarchyTreeNode => {
  const size = estimateNodeSize(node, "hierarchy");
  const children = node.children.map((child, idx) =>
    buildHierarchyTree(child, node.level === 0 ? idx : branchIndex),
  );

  let childrenWidthSum = 0;
  for (let i = 0; i < children.length; i++) {
    childrenWidthSum += children[i].subtreeWidth;
    if (i > 0) {
      childrenWidthSum += 32; // horizontal gap
    }
  }

  const subtreeWidth = Math.max(size.width, childrenWidthSum);

  return {
    raw: node,
    width: size.width,
    height: size.height,
    subtreeWidth,
    branchIndex,
    children,
  };
};

export const layoutHierarchy = (root: OutlineNode): OutlineLayoutResult => {
  const tree = buildHierarchyTree(root, 0);
  const nodes: LayoutedNode[] = [];
  const connections: OutlineLayoutResult["connections"] = [];

  const positionNode = (
    item: HierarchyTreeNode,
    xCenter: number,
    y: number,
    parentId?: string,
  ): LayoutedNode => {
    const x = xCenter - item.width / 2;
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
        style: "elbow",
      });
    }

    if (item.children.length > 0) {
      const childY = y + item.height + 64; // vertical gap
      let currentLeftX = xCenter - item.subtreeWidth / 2;

      for (const child of item.children) {
        const childCenterX = currentLeftX + child.subtreeWidth / 2;
        const childLayouted = positionNode(
          child,
          childCenterX,
          childY,
          item.raw.id,
        );
        layouted.children.push(childLayouted);
        currentLeftX += child.subtreeWidth + 32;
      }
    }

    return layouted;
  };

  positionNode(tree, tree.subtreeWidth / 2, 0);

  return calculateBoundsAndResult(nodes, connections);
};

// ==========================================
// 3. Storyboard (16:9 Frame Cards) Layout
// ==========================================
export const layoutStoryboard = (root: OutlineNode): OutlineLayoutResult => {
  const nodes: LayoutedNode[] = [];
  const connections: OutlineLayoutResult["connections"] = [];
  const frames: NonNullable<OutlineLayoutResult["frames"]> = [];

  const FRAME_WIDTH = 640;
  const FRAME_HEIGHT = 360;
  const FRAME_GAP_X = 64;
  const FRAME_GAP_Y = 64;
  const COLUMNS = root.children.length <= 4 ? root.children.length : 2;

  // Root title banner
  const rootSize = estimateNodeSize(root, "storyboard");
  const rootNode: LayoutedNode = {
    id: root.id,
    text: root.text,
    level: 0,
    branchIndex: 0,
    x: 0,
    y: -80,
    width: Math.max(360, rootSize.width),
    height: 52,
    children: [],
  };
  nodes.push(rootNode);

  // Each Level 1 child is a 16:9 Frame scene
  const sections = root.children.length > 0 ? root.children : [root];

  sections.forEach((section, idx) => {
    const col = idx % (COLUMNS || 1);
    const row = Math.floor(idx / (COLUMNS || 1));
    const frameX = col * (FRAME_WIDTH + FRAME_GAP_X);
    const frameY = row * (FRAME_HEIGHT + FRAME_GAP_Y);
    const frameId = `frame_${section.id}`;
    const frameChildrenIds: string[] = [];

    // Section title inside frame
    const sectionTitleNode: LayoutedNode = {
      id: section.id,
      text: section.text,
      level: 1,
      branchIndex: idx,
      x: frameX + 24,
      y: frameY + 24,
      width: FRAME_WIDTH - 48,
      height: 44,
      frameId,
      children: [],
    };
    nodes.push(sectionTitleNode);
    frameChildrenIds.push(sectionTitleNode.id);

    // Arrange sub-bullets inside this frame
    let subItemY = frameY + 84;
    section.children.forEach((sub, subIdx) => {
      if (subItemY + 44 <= frameY + FRAME_HEIGHT - 20) {
        const subSize = estimateNodeSize(sub, "storyboard");
        const subNode: LayoutedNode = {
          id: sub.id,
          text: sub.text,
          level: 2,
          branchIndex: idx,
          x: frameX + 32,
          y: subItemY,
          width: FRAME_WIDTH - 64,
          height: Math.min(60, subSize.height),
          parentId: section.id,
          frameId,
          children: [],
        };
        nodes.push(subNode);
        frameChildrenIds.push(subNode.id);
        subItemY += subNode.height + 12;
      }
    });

    frames.push({
      id: frameId,
      name: `Scene ${idx + 1}: ${section.text}`,
      x: frameX,
      y: frameY,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      children: frameChildrenIds,
    });

    // Connection arrow between sequential frames
    if (idx > 0) {
      const prevSection = sections[idx - 1];
      connections.push({
        id: `seq_${prevSection.id}_${section.id}`,
        startId: prevSection.id,
        endId: section.id,
        style: "curved",
      });
    }
  });

  return calculateBoundsAndResult(nodes, connections, frames);
};

const calculateBoundsAndResult = (
  nodes: LayoutedNode[],
  connections: OutlineLayoutResult["connections"],
  frames?: OutlineLayoutResult["frames"],
): OutlineLayoutResult => {
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

  if (frames) {
    for (const frame of frames) {
      minX = Math.min(minX, frame.x);
      minY = Math.min(minY, frame.y);
      maxX = Math.max(maxX, frame.x + frame.width);
      maxY = Math.max(maxY, frame.y + frame.height);
    }
  }

  if (minX === Infinity) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }

  return {
    nodes,
    frames,
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

export const layoutOutline = (
  root: OutlineNode,
  layoutType: OutlineLayoutType,
): OutlineLayoutResult => {
  switch (layoutType) {
    case "hierarchy":
      return layoutHierarchy(root);
    case "storyboard":
      return layoutStoryboard(root);
    case "mindmap":
    default:
      return layoutMindmap(root);
  }
};
