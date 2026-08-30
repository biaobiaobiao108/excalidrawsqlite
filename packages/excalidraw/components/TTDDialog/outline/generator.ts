import { FONT_FAMILY, ROUNDNESS } from "@excalidraw/common";
import {
  convertToExcalidrawElements,
  type ExcalidrawElementSkeleton,
} from "@excalidraw/element";

import type {
  NonDeletedExcalidrawElement,
  Theme,
} from "@excalidraw/element/types";

import { getNodeStyle } from "./colorPalette";

import type { OutlineLayoutResult } from "./types";

export const generateExcalidrawFromLayout = (
  layout: OutlineLayoutResult,
  theme: Theme = "light",
): readonly NonDeletedExcalidrawElement[] => {
  const isDark = theme === "dark";
  const skeletons: ExcalidrawElementSkeleton[] = [];

  // 1. Add Frames first if any
  if (layout.frames && layout.frames.length > 0) {
    for (const frame of layout.frames) {
      skeletons.push({
        id: frame.id,
        type: "frame",
        name: frame.name,
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        children: frame.children || [],
      });
    }
  }

  // 2. Add Nodes
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
      frameId: node.frameId || null,
      label: {
        text: node.text,
        fontSize,
        fontFamily,
        textAlign: "center",
        verticalAlign: "middle",
      },
    });
  }

  // 3. Add Connectors
  for (const conn of layout.connections) {
    skeletons.push({
      id: conn.id,
      type: "arrow",
      x: 0,
      y: 0,
      start: { id: conn.startId },
      end: { id: conn.endId },
      strokeColor: conn.color || (isDark ? "#adb5bd" : "#495057"),
      strokeWidth: 1.5,
      roundness: { type: ROUNDNESS.PROPORTIONAL_RADIUS },
      roughness: 1,
      endArrowhead: "arrow",
    });
  }

  return convertToExcalidrawElements(skeletons, { regenerateIds: true });
};
