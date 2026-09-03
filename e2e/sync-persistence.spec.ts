import { test, expect } from "./fixtures";

test.describe("Cloud Sync & Persistence Verification", () => {
  test("should persist scene session and reload without data loss", async ({
    authenticatedPage: page,
  }) => {
    // Navigate to workbench and create a scene
    await expect(page.locator(".workspace-home")).toBeVisible();
    await page.getByRole("button", { name: /新建画板/ }).click();
    await page.waitForURL(/\?id=[a-zA-Z0-9_-]+/);

    const currentUrl = page.url();
    const sceneIdMatch = currentUrl.match(/\?id=([a-zA-Z0-9_-]+)/);
    expect(sceneIdMatch).toBeTruthy();
    const sceneId = sceneIdMatch ? sceneIdMatch[1] : "";

    // Ensure canvas is mounted
    const canvas = page.locator("canvas.excalidraw__canvas").first();
    await expect(canvas).toBeVisible();

    // Verify scene API exists and is queryable
    const apiResponse = await page.request.get(`/api/scenes/${sceneId}`);
    expect(apiResponse.status()).toBe(200);
    const sceneData = await apiResponse.json();
    expect(sceneData.id).toBe(sceneId);

    // Reload the page and ensure the scene reloads smoothly
    await page.reload();
    await expect(canvas).toBeVisible();
    expect(page.url()).toContain(`?id=${sceneId}`);

    // Auth dialog should not re-appear because session cookie is preserved
    const authDialog = page.locator(".auth-dialog");
    await expect(authDialog).not.toBeVisible();
  });
});
