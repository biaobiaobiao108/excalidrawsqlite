import { test, expect } from "@playwright/test";

test("workspace home supports creating a board and mobile layout", async ({ page }) => {
  await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "我的画板" })).toBeVisible();
  await expect(page.getByRole("button", { name: "新建画板" })).toBeVisible();

  await page.getByRole("button", { name: "新建画板" }).click();
  await expect(page).toHaveURL(/\?id=[^&]+$/);
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15000 });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "我的画板" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "C:/Users/biaob/AppData/Local/Temp/excalidraw-workspace-mobile.png", fullPage: true });
});
