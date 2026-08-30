import { describe, it, expect } from "vitest";

import { generateExcalidrawFromLayout } from "./generator";
import {
  layoutHierarchy,
  layoutMindmap,
  layoutOutline,
  layoutStoryboard,
} from "./layout";
import { parseOutlineToTree } from "./parser";

describe("Outline Layout and Generation", () => {
  const sampleMd = `
# System Architecture
## Web Client
- React Canvas
- Vite Bundle
## Server Backend
- Bun SQLite
- REST API
`;

  it("generates mindmap layout with valid coordinates and connections", () => {
    const tree = parseOutlineToTree(sampleMd)!;
    const result = layoutMindmap(tree);

    expect(result.nodes.length).toBe(7); // 1 root + 2 level-1 + 4 level-2
    expect(result.connections.length).toBe(6);
    expect(result.bounds.width).toBeGreaterThan(0);
    expect(result.bounds.height).toBeGreaterThan(0);

    const elements = generateExcalidrawFromLayout(result, "light");
    expect(elements.length).toBeGreaterThanOrEqual(7);

    const helperResult = layoutOutline(tree, "mindmap");
    expect(helperResult.nodes.length).toBe(7);
  });

  it("generates hierarchy tree layout", () => {
    const tree = parseOutlineToTree(sampleMd)!;
    const result = layoutHierarchy(tree);

    expect(result.nodes.length).toBe(7);
    expect(result.connections.length).toBe(6);

    const rootNode = result.nodes.find((n) => n.level === 0)!;
    const level1Nodes = result.nodes.filter((n) => n.level === 1);
    expect(level1Nodes.every((n) => n.y > rootNode.y)).toBe(true);
  });

  it("generates storyboard layout with 16:9 frames", () => {
    const tree = parseOutlineToTree(sampleMd)!;
    const result = layoutStoryboard(tree);

    expect(result.frames).toBeDefined();
    expect(result.frames?.length).toBe(2); // 2 level-1 chapters
    expect(result.frames?.[0].width).toBe(640);
    expect(result.frames?.[0].height).toBe(360);

    const elements = generateExcalidrawFromLayout(result, "light");
    const frameElements = elements.filter((e) => e.type === "frame");
    expect(frameElements.length).toBe(2);
  });
});
