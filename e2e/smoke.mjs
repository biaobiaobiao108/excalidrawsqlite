import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const baseUrl = process.env.E2E_BASE_URL || "http://127.0.0.1:18080";
const password = process.env.E2E_AUTH_PASSWORD || "quality-smoke-password";

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(`E2E assertion failed: ${message}`);
  }
};

const run = async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error?.message || String(error));
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  try {
    // 1. Load home page and authenticate via AuthDialog.
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const passwordInput = page.locator('input[placeholder="请输入访问密码"]');
    await passwordInput.waitFor({ state: "visible", timeout: 15_000 });
    await passwordInput.fill(password);
    await page.locator("button.auth-submit-btn").click();
    await passwordInput.waitFor({ state: "hidden", timeout: 15_000 });

    // 2. Create a new board from WorkspaceHome.
    const createBoardButton = page
      .locator("button", { hasText: /新建画板|新建第一个画板/ })
      .first();
    await createBoardButton.waitFor({ state: "visible", timeout: 15_000 });
    await createBoardButton.click();

    // 3. Wait for editor canvas and draw one rectangle.
    await page.waitForURL(/\?id=scene_/, { timeout: 15_000 });
    const canvas = page.locator(".excalidraw canvas").first();
    await canvas.waitFor({ state: "visible", timeout: 15_000 });

    await page.keyboard.press("r");
    await page.mouse.move(420, 320);
    await page.mouse.down();
    await page.mouse.move(580, 440, { steps: 6 });
    await page.mouse.up();

    // 4. Save to cloud SQLite and navigate back to WorkspaceHome.
    const saveButton = page.locator("button.cloud-save-top-btn");
    await saveButton.waitFor({ state: "visible", timeout: 10_000 });
    await saveButton.click();
    await page
      .locator("button.cloud-save-top-btn", { hasText: "已保存" })
      .waitFor({ state: "visible", timeout: 15_000 });

    await page.locator("button.cloud-scenes-top-btn").click();
    await page.waitForFunction(() => !window.location.search.includes("id="), {
      timeout: 15_000,
    });

    // 5. Verify persistence across full page reload.
    await page.reload({ waitUntil: "networkidle" });
    const boardMeta = page.getByText(/1 个图元/).first();
    await boardMeta.waitFor({ state: "visible", timeout: 15_000 });

    assert(
      pageErrors.length === 0,
      `Uncaught page errors: ${pageErrors.join("; ")}`,
    );
    assert(
      consoleErrors.length === 0,
      `Console errors: ${consoleErrors.join("; ")}`,
    );
    console.log("CI E2E smoke test passed.");
  } finally {
    await context.close();
    await browser.close();
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
