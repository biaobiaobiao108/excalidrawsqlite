import { describe, expect, test } from "bun:test";

describe("workspace styling guards", () => {
  test("Safari board layout avoids content-visibility to prevent scroll stutter and guards virtual grid", async () => {
    const scssContent = await Bun.file(
      "excalidraw-app/components/WorkspaceHome.scss",
    ).text();

    // 1. 确保 .board-card 绝不引入 content-visibility 或 contain-intrinsic-size
    expect(scssContent).toContain(".board-card {");
    const boardCardRule =
      scssContent.match(/(?:^|\n)\.board-card\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(boardCardRule).not.toMatch(/content-visibility/);
    expect(boardCardRule).not.toMatch(/contain-intrinsic-size/);

    // 2. 确保虚拟列表容器明确声明了 overflow-anchor: none 防止浏览器原生滚动锚定干扰
    expect(scssContent).toMatch(
      /\.board-grid-virtualized\s*\{[^}]*overflow-anchor:\s*none;/,
    );

    // 3. 确保 .workspace-home 容器启用 -webkit-overflow-scrolling: touch
    expect(scssContent).toMatch(
      /\.workspace-home\s*\{[^}]*-webkit-overflow-scrolling:\s*touch;/,
    );
  });
});
