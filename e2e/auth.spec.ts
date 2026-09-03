import { test, expect } from "@playwright/test";
import { TEST_PASSWORD } from "./fixtures";

test.describe("Authentication & Session Lifecycle", () => {
  test("should display auth dialog and reject invalid password", async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.goto("/");

    const authDialog = page.locator(".auth-dialog");
    await expect(authDialog).toBeVisible();
    await expect(page.locator(".auth-dialog-title")).toHaveText(
      "访问授权验证",
    );

    // Try empty password
    const submitBtn = page.locator("button.auth-submit-btn");
    await submitBtn.click();
    await expect(page.locator(".auth-dialog-error")).toContainText(
      "请输入访问密码",
    );

    // Try incorrect password
    const passwordInput = page.locator('input[name="password"]');
    await passwordInput.fill("wrong-password");
    await submitBtn.click();
    await expect(page.locator(".auth-dialog-error")).toContainText(
      "访问密码错误，请重新输入",
    );
  });

  test("should authenticate successfully and set HttpOnly session cookie", async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.goto("/");

    const authDialog = page.locator(".auth-dialog");
    await expect(authDialog).toBeVisible();

    const passwordInput = page.locator('input[name="password"]');
    await passwordInput.fill(TEST_PASSWORD);
    await page.locator("button.auth-submit-btn").click();

    await expect(authDialog).not.toBeVisible();

    // Verify session cookie
    const cookies = await context.cookies();
    const sessionCookie = cookies.find((c) => c.name === "excalidraw_session");
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie?.httpOnly).toBe(true);

    // Verify workbench is rendered
    await expect(page.locator(".workspace-home")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /新建画板/ }),
    ).toBeVisible();
  });
});
