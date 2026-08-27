const { chromium } = await import(
  "C:/Users/biaob/scoop/persist/bun/install/cache/playwright@1.62.1@@@1/index.mjs",
);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle" });
if (!(await page.getByRole("heading", { name: "我的画板" }).isVisible())) {
  throw new Error("workspace heading is not visible");
}
if (!(await page.getByRole("button", { name: "新建画板" }).isVisible())) {
  throw new Error("create board button is not visible");
}

await page.getByRole("button", { name: "新建画板" }).click();
await page.waitForURL(/\?id=[^&]+$/);
await page.locator(".excalidraw").waitFor({ state: "visible", timeout: 15000 });

await page.setViewportSize({ width: 390, height: 844 });
await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle" });
if (!(await page.getByRole("heading", { name: "我的画板" }).isVisible())) {
  throw new Error("mobile workspace heading is not visible");
}
const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
if (scrollWidth > 390) {
  throw new Error(`mobile layout overflows: ${scrollWidth}px`);
}
await page.screenshot({
  path: "C:/Users/biaob/AppData/Local/Temp/excalidraw-workspace-mobile.png",
  fullPage: true,
});
await browser.close();
console.log("workspace smoke test passed");
