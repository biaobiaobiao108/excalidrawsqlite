import { FONT_FAMILY, ROUNDNESS } from "@excalidraw/common";
import {
  convertToExcalidrawElements,
  type ExcalidrawElementSkeleton,
} from "@excalidraw/element";
import { pointFrom, type LocalPoint } from "@excalidraw/math";

import type {
  NonDeletedExcalidrawElement,
  Theme,
} from "@excalidraw/element/types";

import { getNodeStyle, getBranchLineColor } from "./colorPalette";

import type { OutlineLayoutResult } from "./types";

export const generateExcalidrawFromLayout = (
  layout: OutlineLayoutResult,
  theme: Theme = "light",
): readonly NonDeletedExcalidrawElement[] => {
  const isDark = theme === "dark";
  const skeletons: ExcalidrawElementSkeleton[] = [];

  const nodeMap = new Map(layout.nodes.map((n) => [n.id, n]));

  // 1. Add Nodes
  const fontFamily = FONT_FAMILY["霞鹜文楷"] || 11;

  for (const node of layout.nodes) {
    const style = getNodeStyle(node.level, node.branchIndex, isDark);
    const fontSize = node.level === 0 ? 18 : node.level === 1 ? 16 : 14;

    skeletons.push({
      id: node.id,
      type: "rectangle",
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      backgroundColor: style.backgroundColor,
      strokeColor: style.strokeColor,
      strokeWidth: style.strokeWidth,
      fillStyle: style.fillStyle,
      roundness: { type: style.roundness },
      roughness: 1,
      label: {
        text: node.text,
        fontSize,
        fontFamily,
        textAlign: "center",
        verticalAlign: "middle",
      },
    });
  }

  // 2. Add Connectors
  for (const conn of layout.connections) {
    const startNode = nodeMap.get(conn.startId);
    const endNode = nodeMap.get(conn.endId);

    if (!startNode || !endNode) {
      continue;
    }

    const startX = startNode.x + startNode.width;
    const startY = startNode.y + startNode.height / 2;
    const endX = endNode.x;
    const endY = endNode.y + endNode.height / 2;

    const dx = endX - startX;
    const dy = endY - startY;

    // Direct clean connection from parent right edge to child left edge
    const points: readonly LocalPoint[] = [
      pointFrom<LocalPoint>(0, 0),
      pointFrom<LocalPoint>(dx, dy),
    ];

    const lineColor = getBranchLineColor(conn.branchIndex, isDark);

    skeletons.push({
      id: conn.id,
      type: "arrow",
      x: startX,
      y: startY,
      width: Math.abs(dx) || 1,
      height: Math.abs(dy) || 1,
      points,
      start: { id: conn.startId },
      end: { id: conn.endId },
      strokeColor: lineColor,
      strokeWidth: conn.level <= 1 ? 2 : 1.5,
      roundness: { type: ROUNDNESS.PROPORTIONAL_RADIUS },
      roughness: 1,
      endArrowhead: null,
    });
  }

  return convertToExcalidrawElements(skeletons, { regenerateIds: true });
};
