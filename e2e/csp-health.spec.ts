import { test, expect } from "@playwright/test";
import { TEST_PASSWORD } from "./fixtures";

test.describe("CSP & Browser Console Health", () => {
  test("should load workbench and canvas with zero CSP violations", async ({
    page,
  }) => {
    const cspViolations: string[] = [];

    page.on("console", (msg) => {
      const text = msg.text();
      if (
        text.includes("Content Security Policy") ||
        text.includes("violates the following directive")
      ) {
        cspViolations.push(text);
      }
    });

    // 1. Visit homepage
    await page.goto("/");

    // 2. Authenticate
    const passwordInput = page.locator('input[name="password"]');
    await passwordInput.fill(TEST_PASSWORD);
    await page.locator("button.auth-submit-btn").click();
    await expect(page.locator(".auth-dialog")).not.toBeVisible();

    // 3. Workbench is visible
    await expect(page.locator(".workspace-home")).toBeVisible();

    // 4. The browser tab has a stable favicon fallback and the asset is served.
    await expect(
      page.locator('link[rel="icon"][href$="/favicon.ico"]'),
    ).toHaveCount(1);
    const faviconResponse = await page.request.get("/favicon.ico");
    expect(faviconResponse.ok()).toBe(true);
    expect(faviconResponse.headers()["content-type"]).toContain("image/x-icon");

    // 5. Open a canvas
    await page.getByRole("button", { name: /新建画板/ }).click();
    await page.waitForURL(/\?id=[a-zA-Z0-9_-]+/);
    await expect(
      page.locator("canvas.excalidraw__canvas").first(),
    ).toBeVisible();

    // Stabilization timeout for fonts and scripts
    await page.waitForTimeout(1000);

    // 5. Assert zero CSP violations
    expect(cspViolations).toEqual([]);
  });
});
