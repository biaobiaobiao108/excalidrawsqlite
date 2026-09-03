import { test as base, expect, type Page } from "@playwright/test";

export const TEST_PASSWORD = "test-e2e-password";

export async function loginWithPassword(
  page: Page,
  password = TEST_PASSWORD,
) {
  await page.goto("/");
  const passwordInput = page.locator('input[name="password"]');
  // Automatically wait for the password input to appear
  await passwordInput.waitFor({ state: "visible", timeout: 8000 });
  await passwordInput.fill(password);
  await page.locator("button.auth-submit-btn").click();
  await expect(page.locator(".auth-dialog")).not.toBeVisible();
}

export const test = base.extend<{
  authenticatedPage: Page;
}>({
  authenticatedPage: async ({ page }, use) => {
    await loginWithPassword(page);
    await use(page);
  },
});

export { expect };
