import type { RoundnessType } from "@excalidraw/element/types";

export type OutlineNode = {
  id: string;
  text: string;
  level: number;
  children: OutlineNode[];
  parent?: OutlineNode;
};

export type OutlineLayoutType = "mindmap";

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
};

export type OutlineConnection = {
  id: string;
  startId: string;
  endId: string;
  branchIndex: number;
  level: number;
};

export type OutlineLayoutResult = {
  nodes: LayoutedNode[];
  connections: OutlineConnection[];
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
