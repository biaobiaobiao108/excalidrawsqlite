import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium, webkit } = require("playwright");

const baseUrl = process.env.E2E_BASE_URL || "http://127.0.0.1:18080";
const password = process.env.E2E_AUTH_PASSWORD || "quality-smoke-password";
const browserName = (process.env.E2E_BROWSER || "chromium").toLowerCase();
const browserType = { chromium, webkit }[browserName];

if (!browserType) {
  throw new Error(`Unsupported E2E_BROWSER: ${browserName}`);
}

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(`E2E assertion failed: ${message}`);
  }
};

const run = async () => {
  const browser = await browserType.launch({
    headless: true,
    ...(process.env.E2E_BROWSER_EXECUTABLE
      ? { executablePath: process.env.E2E_BROWSER_EXECUTABLE }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  const waitForWorkspaceIdle = async () => {
    await page.waitForFunction(
      () => {
        const content = document.querySelector(".workspace-home [aria-busy]");
        return content?.getAttribute("aria-busy") === "false";
      },
      null,
      { timeout: 15_000 },
    );
  };
  page.on("pageerror", (error) => {
    pageErrors.push(
      `${new Date().toISOString()} ${page.url()} ${
        error?.stack || error?.message || String(error)
      }`,
    );
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      const text = message.text();
      // Chromium 159 reports its own unload deprecation policy here.
      if (text.includes("Permissions policy violation: unload")) {
        return;
      }
      consoleErrors.push(text);
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
    await waitForWorkspaceIdle();

    // 2. Verify the custom select exposes keyboard activity separately from
    // its selected value and releases focus state on Escape.
    const sortSelect = page.getByRole("combobox", { name: "排序方式" });
    await sortSelect.waitFor({ state: "visible", timeout: 15_000 });
    assert(
      (await sortSelect.getAttribute("aria-expanded")) === "false",
      "sort select should start collapsed",
    );
    await sortSelect.focus();
    await page.keyboard.press("ArrowDown");
    assert(
      (await sortSelect.getAttribute("aria-expanded")) === "true",
      "ArrowDown should open the sort select",
    );
    const initialActiveId = await sortSelect.getAttribute(
      "aria-activedescendant",
    );
    assert(initialActiveId, "open sort select should expose an active option");
    const selectedId = await page
      .locator('.custom-select__option[aria-selected="true"]')
      .getAttribute("id");
    assert(selectedId, "sort select should keep its selected option marked");

    await page.keyboard.press("ArrowDown");
    const nextActiveId = await sortSelect.getAttribute("aria-activedescendant");
    assert(
      nextActiveId && nextActiveId !== initialActiveId,
      "ArrowDown should move the active option",
    );
    assert(
      (await page
        .locator('.custom-select__option[aria-selected="true"]')
        .getAttribute("id")) === selectedId,
      "moving the active option must not change the selected value",
    );
    await page.keyboard.press("End");
    const lastActiveId = await sortSelect.getAttribute("aria-activedescendant");
    assert(lastActiveId, "End should focus the last enabled option");
    assert(
      (await page
        .locator(`[id="${lastActiveId}"]`)
        .getAttribute("role")) === "option",
      "aria-activedescendant should reference an option",
    );
    await page.keyboard.press("Escape");
    assert(
      (await sortSelect.getAttribute("aria-expanded")) === "false" &&
        (await sortSelect.getAttribute("aria-activedescendant")) === null,
      "Escape should close the select and clear its active option",
    );

    // 3. Create a new board from WorkspaceHome.
    const createBoardButton = page
      .locator("button", { hasText: /新建画板|新建第一个画板/ })
      .first();
    await createBoardButton.waitFor({ state: "visible", timeout: 15_000 });
    await createBoardButton.click();

    // 4. Wait for editor canvas and draw one rectangle.
    await page.waitForURL(/\?id=scene_/, { timeout: 15_000 });
    const canvas = page.locator(".excalidraw canvas").first();
    await canvas.waitFor({ state: "visible", timeout: 15_000 });

    const rectangleTool = page.locator('[data-testid="toolbar-rectangle"]');
    await rectangleTool.waitFor({ state: "visible", timeout: 15_000 });
    await rectangleTool.click();
    await page
      .locator('[data-testid="toolbar-rectangle"][aria-pressed="true"]')
      .waitFor({ state: "visible", timeout: 5_000 });
    await page.mouse.move(420, 320);
    await page.mouse.down();
    await page.mouse.move(580, 440, { steps: 6 });
    await page.mouse.up();

    // 5. Save to cloud SQLite and navigate back to WorkspaceHome.
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
    await waitForWorkspaceIdle();

    // 6. Verify persistence across full page reload.
    await page.reload({ waitUntil: "networkidle" });
    await waitForWorkspaceIdle();
    const boardMeta = page.getByText(/1 个图元/).first();
    await boardMeta.waitFor({ state: "visible", timeout: 15_000 });

    // 7. Verify the narrow layout and themed sticky sidebar.
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileLayout = await page.evaluate(() => {
      const sidebar = document.querySelector(".workspace-sidebar");
      const workspace = document.querySelector(".workspace-home");
      if (!(sidebar instanceof HTMLElement) || !(workspace instanceof HTMLElement)) {
        return null;
      }
      const lightBackground = getComputedStyle(sidebar).backgroundColor;
      const lightToken = getComputedStyle(workspace)
        .getPropertyValue("--workspace-sidebar")
        .trim();
      document.documentElement.classList.add("dark");
      const darkBackground = getComputedStyle(sidebar).backgroundColor;
      const darkToken = getComputedStyle(workspace)
        .getPropertyValue("--workspace-sidebar")
        .trim();
      document.documentElement.classList.remove("dark");
      return {
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        sidebarPosition: getComputedStyle(sidebar).position,
        lightBackground,
        darkBackground,
        lightToken,
        darkToken,
      };
    });
    assert(mobileLayout, "mobile workspace layout should be present");
    assert(
      mobileLayout.innerWidth === 390 &&
        mobileLayout.scrollWidth <= mobileLayout.innerWidth + 1,
      `mobile layout overflowed: ${JSON.stringify(mobileLayout)}`,
    );
    assert(
      mobileLayout.sidebarPosition === "sticky",
      "mobile sidebar should stay attached while scrolling",
    );
    assert(
      mobileLayout.lightToken !== mobileLayout.darkToken &&
        mobileLayout.lightBackground !== mobileLayout.darkBackground,
      "mobile sidebar should follow the active theme",
    );

    // 8. A failed image request must leave a usable card rather than a broken
    // preview icon or an exception.
    const thumbnail = page.locator(".board-thumbnail img").first();
    await thumbnail.waitFor({ state: "visible", timeout: 15_000 });
    await thumbnail.evaluate((image) => {
      image.dispatchEvent(new Event("error"));
    });
    await page
      .getByText("预览暂不可用")
      .first()
      .waitFor({ state: "visible", timeout: 5_000 });

    assert(
      pageErrors.length === 0,
      `Uncaught page errors: ${pageErrors.join("; ")}`,
    );
    assert(
      consoleErrors.length === 0,
      `Console errors: ${consoleErrors.join("; ")}`,
    );
    console.log(`CI E2E smoke test passed (${browserName}).`);
  } finally {
    await context.close();
    await browser.close();
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
