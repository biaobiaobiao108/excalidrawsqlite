import { test, expect } from "./fixtures";
import type { Locator } from "@playwright/test";

const readRect = async (locator: Locator) => {
  return locator.evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  });
};

const expectRectsToMatch = (
  actual: Awaited<ReturnType<typeof readRect>>,
  expected: Awaited<ReturnType<typeof readRect>>,
) => {
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(actual[key] - expected[key])).toBeLessThanOrEqual(1);
  }
};

test.describe("Workspace behavior", () => {
  test("manages folders, metadata, favorites, and the recycle bin", async ({
    authenticatedPage: page,
  }) => {
    const suffix = Date.now().toString(36);
    const folderName = `E2E 文件夹 ${suffix}`;
    const sceneName = `E2E 画板 ${suffix}`;
    const renamedScene = `${sceneName} 已重命名`;

    const folderResponse = await page.request.post("/api/folders", {
      data: { name: folderName },
    });
    expect(folderResponse.status()).toBe(201);
    const folder = await folderResponse.json();

    const sceneResponse = await page.request.post("/api/scenes", {
      data: {
        name: sceneName,
        folder_id: folder.id,
        tags: ["e2e"],
        elements: [],
        appState: {},
      },
    });
    expect(sceneResponse.status()).toBe(201);
    const scene = await sceneResponse.json();

    try {
      await page.reload();
      const card = () =>
        page
          .locator(".all-boards-section .board-grid .board-card")
          .filter({ hasText: renamedScene });
      const originalCard = () =>
        page
          .locator(".all-boards-section .board-grid .board-card")
          .filter({ hasText: sceneName });

      await expect(originalCard()).toBeVisible();
      await originalCard()
        .getByRole("button", { name: "收藏画板" })
        .click();
      await expect(
        originalCard().getByRole("button", { name: "取消收藏" }),
      ).toBeVisible();

      await originalCard()
        .getByRole("button", { name: `编辑画板信息“${sceneName}”` })
        .click();
      const metadataDialog = page.locator("dialog[open]");
      await expect(metadataDialog).toBeVisible();
      await metadataDialog.locator("input").nth(0).fill(renamedScene);
      await metadataDialog.locator("input").nth(1).fill("browser, e2e");
      await metadataDialog.getByRole("button", { name: "保存信息" }).click();
      await expect(metadataDialog).not.toBeVisible();

      await expect(card()).toBeVisible();
      await expect(card()).toContainText(folderName);
      await expect(card()).toContainText("browser");

      const folderRow = page
        .locator(".folder-row")
        .filter({ hasText: folderName });
      await expect(folderRow.locator("small")).toHaveText("1");
      await folderRow.locator("button").first().click();
      await expect(page.locator(".all-boards-heading h2")).toHaveText(
        folderName,
      );
      await expect(card()).toBeVisible();

      await card()
        .getByRole("button", { name: `移至回收站“${renamedScene}”` })
        .click();
      await expect(folderRow.locator("small")).toHaveText("0");
      await page
        .locator(".workspace-nav button")
        .filter({ hasText: "回收站" })
        .click();
      const trashCard = () =>
        page
          .locator(".all-boards-section .board-grid .board-card")
          .filter({ hasText: renamedScene });
      await expect(trashCard()).toBeVisible();

      await trashCard()
        .getByRole("button", { name: `还原画板“${renamedScene}”` })
        .click();
      await expect(trashCard()).not.toBeVisible();
      await expect(folderRow.locator("small")).toHaveText("1");

      const scenesResponse = await page.request.get("/api/scenes");
      const scenes = await scenesResponse.json();
      const persisted = scenes.find((item: { id: string }) => item.id === scene.id);
      expect(persisted.name).toBe(renamedScene);
      expect(persisted.favorite).toBe(true);
    } finally {
      await page.request.delete(`/api/scenes/${scene.id}?permanent=true`);
      await page.request.delete(`/api/folders/${folder.id}`);
    }
  });

  test("synchronizes workspace mutations across open tabs", async ({
    authenticatedPage: page,
  }) => {
    const suffix = Date.now().toString(36);
    const folderName = `E2E 跨标签文件夹 ${suffix}`;
    const renamedFolder = `${folderName} 已更新`;
    const secondPage = await page.context().newPage();
    const folderResponse = await page.request.post("/api/folders", {
      data: { name: folderName },
    });
    expect(folderResponse.status()).toBe(201);
    const folder = await folderResponse.json();

    try {
      await page.reload();
      await secondPage.goto("/");
      const firstFolderRow = page
        .locator(".folder-row")
        .filter({ hasText: folderName });
      const secondFolderRow = secondPage
        .locator(".folder-row")
        .filter({ hasText: folderName });
      await expect(firstFolderRow).toBeVisible();
      await expect(secondFolderRow).toBeVisible();

      await firstFolderRow.hover();
      await firstFolderRow.locator("button.folder-more").click();
      const folderDialog = page.locator("dialog[open]");
      await folderDialog.locator("input").fill(renamedFolder);
      await folderDialog.getByRole("button", { name: "保存" }).click();

      await expect(
        page.locator(".folder-row").filter({ hasText: renamedFolder }),
      ).toBeVisible();
      expect(
        await page.evaluate(() =>
          JSON.parse(
            window.localStorage.getItem(
              "excalidraw_cloud_tab_sync_message",
            ) || "null",
          ),
        ),
      ).toMatchObject({ type: "workspace_changed" });

      await expect(
        secondPage.locator(".folder-row").filter({ hasText: renamedFolder }),
      ).toBeVisible();
    } finally {
      await page.request
        .delete(`/api/folders/${folder.id}`, { timeout: 3_000 })
        .catch(() => {});
      await secondPage.close().catch(() => {});
    }
  });

  test("uploads and serves an attachment through the authenticated API", async ({
    authenticatedPage: page,
  }) => {
    const fileId = `e2e-file-${Date.now().toString(36)}`;
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );

    const upload = await page.request.put(`/api/files/${fileId}`, {
      headers: { "Content-Type": "image/png" },
      data: png,
    });
    expect([200, 201]).toContain(upload.status());

    const download = await page.request.get(`/api/files/${fileId}`, {
      headers: { Accept: "application/octet-stream" },
    });
    expect(download.status()).toBe(200);
    expect(download.headers()["content-type"]).toContain("image/png");
    expect(Buffer.from(await download.body())).toEqual(png);
  });

  test("keeps the workspace usable at the mobile breakpoint", async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();

    await expect(page.locator(".workspace-home")).toBeVisible();
    await expect(page.locator(".workspace-layout")).toBeVisible();
    await expect(page.locator(".workspace-nav")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /新建画板/ }),
    ).toBeVisible();
  });

  test("keeps the home command palette stable while creating a named board", async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator(".workspace-home")).toBeVisible();
    await page.keyboard.press("Control+Shift+p");

    const palette = page.locator("dialog.workspace-command-palette-dialog");
    const input = palette.locator(
      'input[aria-label="搜索菜单、命令或画板"]',
    );
    const shell = palette.locator(".workspace-dialog-content-shell");
    await expect(palette).toBeVisible();
    await page.waitForTimeout(250);

    const shellBaseline = await readRect(shell);
    const inputBaseline = await readRect(input);
    for (const query of ["", "新", "新建", "新建 任意名称"]) {
      await input.fill(query);
      await expect(input).toHaveValue(query);
      await page.waitForTimeout(30);
      expectRectsToMatch(await readRect(shell), shellBaseline);
      expectRectsToMatch(await readRect(input), inputBaseline);
    }

    await expect(
      palette.locator(".command-item").filter({ hasText: "任意名称" }),
    ).toBeVisible();
    await input.press("Enter");
    await page.waitForURL(/\?id=/);

    const sceneId = new URL(page.url()).searchParams.get("id");
    expect(sceneId).toBeTruthy();
    const scenesResponse = await page.request.get("/api/scenes");
    const scenes = await scenesResponse.json();
    expect(
      scenes.some(
        (scene: { id: string; name: string }) =>
          scene.id === sceneId && scene.name === "任意名称",
      ),
    ).toBe(true);

    await page.request.delete(`/api/scenes/${sceneId}?permanent=true`);
  });

  test("matches the editor command palette geometry", async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.keyboard.press("Control+Shift+p");

    const workspacePalette = page.locator(
      "dialog.workspace-command-palette-dialog",
    );
    await expect(workspacePalette).toBeVisible();
    await page.waitForTimeout(250);
    const workspaceShell = await readRect(
      workspacePalette.locator(".workspace-dialog-content-shell"),
    );
    const workspaceInput = await readRect(
      workspacePalette.locator('input[aria-label="搜索菜单、命令或画板"]'),
    );

    await page.keyboard.press("Escape");
    await expect(workspacePalette).not.toBeVisible();
    await page.getByRole("button", { name: /新建画板/ }).first().click();
    await page.waitForURL(/\?id=/);
    await expect(page.locator("canvas.excalidraw__canvas").first()).toBeVisible();

    await page.getByTestId("main-menu-trigger").click();
    await page.getByTestId("command-palette-button").click();
    const editorPalette = page.locator(".command-palette-dialog");
    await expect(editorPalette).toBeVisible();
    await page.waitForTimeout(250);

    expectRectsToMatch(
      await readRect(editorPalette.locator(".Modal__content")),
      workspaceShell,
    );
    expectRectsToMatch(
      await readRect(editorPalette.locator("input").first()),
      workspaceInput,
    );

    const sceneId = new URL(page.url()).searchParams.get("id");
    if (sceneId) {
      await page.request.delete(`/api/scenes/${sceneId}?permanent=true`);
    }
  });

  test("keeps the mobile home command palette stable", async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator(".workspace-home")).toBeVisible();
    await page.keyboard.press("Control+Shift+p");

    const palette = page.locator("dialog.workspace-command-palette-dialog");
    const input = palette.locator(
      'input[aria-label="搜索菜单、命令或画板"]',
    );
    const shell = palette.locator(".workspace-dialog-content-shell");
    await expect(palette).toBeVisible();
    await page.waitForTimeout(250);

    const shellBaseline = await readRect(shell);
    const inputBaseline = await readRect(input);
    expect(shellBaseline.x).toBeLessThanOrEqual(1);
    expect(shellBaseline.y).toBeLessThanOrEqual(1);
    expect(Math.abs(shellBaseline.width - 390)).toBeLessThanOrEqual(1);
    expect(Math.abs(shellBaseline.height - 844)).toBeLessThanOrEqual(1);

    for (const query of ["", "新", "新建", "新建 移动端名称"]) {
      await input.fill(query);
      await expect(input).toHaveValue(query);
      await page.waitForTimeout(30);
      expectRectsToMatch(await readRect(shell), shellBaseline);
      expectRectsToMatch(await readRect(input), inputBaseline);
    }
  });

  test("switches the editor language through the accessible menu", async ({
    authenticatedPage: page,
  }) => {
    await page.getByRole("button", { name: /新建画板/ }).click();
    await page.waitForURL(/\?id=/);
    await expect(page.locator("canvas.excalidraw__canvas").first()).toBeVisible();

    await page.getByTestId("main-menu-trigger").click();
    const languageButton = page.getByRole("button", {
      name: /Select language|选择语言/,
    });
    await expect(languageButton).toBeVisible();
    const languageLabel = await languageButton.getAttribute("aria-label");
    await languageButton.click();
    await expect(
      page.getByRole("listbox", { name: languageLabel || undefined }),
    ).toBeVisible();
    await page.getByRole("option", { name: "English" }).click();
    await expect(
      page.getByRole("button", { name: "Select language" }),
    ).toBeVisible();
  });
});
