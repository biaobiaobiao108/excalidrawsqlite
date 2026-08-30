import type { RoundnessType } from "@excalidraw/element/types";

export type OutlineNode = {
  id: string;
  text: string;
  level: number;
  children: OutlineNode[];
  parent?: OutlineNode;
};

export type OutlineLayoutType = "mindmap" | "hierarchy" | "storyboard";

export type LayoutedNode = {
  id: string;
  text: string;
  level: number;
  branchIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  parentId?: string;
  children: LayoutedNode[];
  frameId?: string;
};

export type OutlineLayoutResult = {
  nodes: LayoutedNode[];
  frames?: Array<{
    id: string;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    children: string[];
  }>;
  connections: Array<{
    id: string;
    startId: string;
    endId: string;
    style?: "curved" | "elbow" | "straight";
    color?: string;
  }>;
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
  };
};

export type NodeThemeStyle = {
  backgroundColor: string;
  strokeColor: string;
  textColor: string;
  strokeWidth: number;
  roundness: RoundnessType;
  fillStyle: "solid" | "hachure" | "cross-hatch";
};
