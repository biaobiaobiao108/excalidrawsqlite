import { test, expect, TEST_PASSWORD } from "./fixtures";

test.describe("CSP & Browser Console Health", () => {
  test("should load workbench and canvas with zero CSP violations", async ({
    page,
  }) => {
    const cspViolations = [];

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

    // 4. Open a canvas
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
