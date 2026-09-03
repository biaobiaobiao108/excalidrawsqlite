import { test, expect } from "./fixtures";

test.describe("Workbench & Scene Management", () => {
  test("should load workbench and create a new scene", async ({
    authenticatedPage: page,
  }) => {
    await expect(page.locator(".workspace-home")).toBeVisible();

    // Click create new board button
    const createBtn = page.getByRole("button", { name: /新建画板/ });
    await expect(createBtn).toBeVisible();
    await createBtn.click();

    // URL should update with a new scene ID
    await page.waitForURL(/\?id=[a-zA-Z0-9_-]+/);
    expect(page.url()).toContain("?id=");

    // Excalidraw canvas should mount
    const canvas = page.locator("canvas.excalidraw__canvas").first();
    await expect(canvas).toBeVisible();

    // Return to workbench using header button or direct navigation
    const backBtn = page.locator('button[title*="管理我的云端画板"]');
    if (await backBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await backBtn.click();
    } else {
      await page.goto("/");
    }

    // Workbench should be displayed again and list at least one scene
    await expect(page.locator(".workspace-home")).toBeVisible();
    const sceneCards = page.locator(".board-card");
    await expect(sceneCards.first()).toBeVisible();
  });
});
