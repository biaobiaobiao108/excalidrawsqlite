import { describe, it, expect } from "vitest";

import { generateExcalidrawFromLayout } from "./generator";
import { layoutMindmap, layoutOutline } from "./layout";
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

  it("generates mindmap layout with valid coordinates and smooth connections", () => {
    const tree = parseOutlineToTree(sampleMd)!;
    const result = layoutMindmap(tree);

    expect(result.nodes.length).toBe(7); // 1 root + 2 level-1 + 4 level-2
    expect(result.connections.length).toBe(6);
    expect(result.bounds.width).toBeGreaterThan(0);
    expect(result.bounds.height).toBeGreaterThan(0);

    const elements = generateExcalidrawFromLayout(result, "light");
    // 7 rectangles + 7 bound text elements + 6 arrows = 20 elements
    expect(elements.length).toBe(20);

    const rectangles = elements.filter((el) => el.type === "rectangle");
    expect(rectangles.length).toBe(7);

    const arrows = elements.filter((el) => el.type === "arrow");
    expect(arrows.length).toBe(6);
    expect(arrows.every((a) => (a as any).endArrowhead === null)).toBe(true);

    const helperResult = layoutOutline(tree, "mindmap");
    expect(helperResult.nodes.length).toBe(7);
  });
});
