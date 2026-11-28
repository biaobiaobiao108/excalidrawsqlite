import { describe, expect, test } from "bun:test";

const channelLuminance = (channel: number) => {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const contrastRatio = (foreground: string, background: string) => {
  const luminance = (hex: string) => {
    const channels = hex
      .slice(1)
      .match(/.{2}/g)!
      .map((channel) => channelLuminance(Number.parseInt(channel, 16)));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
};

const readCssBlock = (scssContent: string, selector: string) => {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    scssContent.match(
      new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{([\\s\\S]*?)\\n\\}`),
    )?.[1] ?? ""
  );
};

const readHexToken = (block: string, token: string) => {
  const value = block.match(
    new RegExp(`--${token}:\\s*(#[0-9a-f]{6})`, "i"),
  )?.[1];
  expect(value).toBeTruthy();
  return value!;
};

const readWorkspaceStyles = async () => {
  const files = [
    "WorkspaceHome.scss",
    "_workspace-theme.scss",
    "_workspace-navigation.scss",
    "_workspace-boards.scss",
    "_workspace-dialogs.scss",
    "_workspace-responsive.scss",
    "_workspace-overrides.scss",
  ];
  const contents = await Promise.all(
    files.map((file) => Bun.file(`excalidraw-app/components/${file}`).text()),
  );
  return contents.join("\n");
};

describe("workspace styling guards", () => {
  test("Safari board layout avoids content-visibility to prevent scroll stutter and guards virtual grid", async () => {
    const scssContent = await readWorkspaceStyles();

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

  test("keeps workspace navigation and empty thumbnails at WCAG AA contrast", async () => {
    const workspaceStyles = await readWorkspaceStyles();
    const themeTokens = await Bun.file("excalidraw-app/index.scss").text();
    const lightTokens = readCssBlock(themeTokens, ":root");
    const darkTokens = readCssBlock(themeTokens, "html.dark");

    const lightMuted = readHexToken(lightTokens, "text-secondary");
    const lightSidebar = readHexToken(lightTokens, "surface-sidebar");
    const lightPanel = readHexToken(lightTokens, "surface-panel");
    const darkMuted = readHexToken(darkTokens, "text-secondary");
    const darkSidebar = readHexToken(darkTokens, "surface-sidebar");

    expect(contrastRatio(lightMuted, lightSidebar)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(lightMuted, lightPanel)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(darkMuted, darkSidebar)).toBeGreaterThanOrEqual(4.5);

    const navigationRule = readCssBlock(
      workspaceStyles,
      ".workspace-nav button,\n.folder-row > button:first-child",
    );
    const thumbnailRule = readCssBlock(
      workspaceStyles,
      ".board-thumbnail-empty",
    );
    expect(navigationRule).toContain("color: var(--workspace-muted)");
    expect(thumbnailRule).toContain("color: var(--workspace-muted)");
    expect(workspaceStyles).toMatch(
      /html\.dark \.workspace-nav button:hover,\s*html\.dark \.folder-row:hover\s*\{[^}]*background:\s*var\(--workspace-surface-hover\)/,
    );
  });

  test("keeps navigation and search controls usable when text is enlarged", async () => {
    const workspaceStyles = await readWorkspaceStyles();
    const customSelectStyles = await Bun.file(
      "excalidraw-app/components/CustomSelect.scss",
    ).text();

    expect(workspaceStyles).toMatch(
      /\.workspace-search\s*\{[^}]*container-type:\s*inline-size;/,
    );
    expect(workspaceStyles).toMatch(
      /@container\s*\(max-width:\s*14rem\)\s*\{[^}]*\.workspace-search kbd\s*\{[^}]*display:\s*none;/s,
    );
    expect(workspaceStyles).toMatch(
      /@container\s*\(max-width:\s*19rem\)\s*\{[^}]*\.workspace-nav\s*\{[^}]*flex-wrap:\s*wrap;[^}]*\}/s,
    );
    expect(workspaceStyles).toMatch(
      /\.workspace-layout\s*\{[^}]*grid-template-columns:\s*clamp\(\s*300px,\s*calc\(16rem \+ 44px\),\s*440px\s*\)/s,
    );
    expect(workspaceStyles).toMatch(
      /grid-template-columns:\s*clamp\(\s*210px,\s*calc\(11rem \+ 34px\),\s*360px\s*\)/s,
    );
    expect(customSelectStyles).toMatch(
      /\.custom-select__label\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    );
  });

  test("derives the mobile sidebar surface from the active theme", async () => {
    const workspaceStyles = await readWorkspaceStyles();

    expect(workspaceStyles).toMatch(
      /\.workspace-sidebar\s*\{[^}]*background:\s*color-mix\(\s*in srgb,\s*var\(--workspace-sidebar\) 97%,\s*transparent\s*\)/s,
    );
    expect(workspaceStyles).not.toContain("rgba(244, 242, 236, 0.97)");
  });
});
