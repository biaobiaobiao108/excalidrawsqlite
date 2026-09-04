import { test, expect } from "./fixtures";

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

      await expect(card()).toBeVisible();
      await expect(card()).toContainText(folderName);
      await expect(card()).toContainText("browser");

      const folderRow = page
        .locator(".folder-row")
        .filter({ hasText: folderName });
      await folderRow.locator("button").first().click();
      await expect(page.locator(".all-boards-heading h2")).toHaveText(
        folderName,
      );
      await expect(card()).toBeVisible();

      await card()
        .getByRole("button", { name: `移至回收站“${renamedScene}”` })
        .click();
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

    const download = await page.request.get(`/api/files/${fileId}`);
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
