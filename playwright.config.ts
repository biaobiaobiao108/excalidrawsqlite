import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const PORT = 5055;
const DATA_DIR = path.resolve(__dirname, "data-e2e");
const STATIC_DIR = path.resolve(__dirname, "excalidraw-app/build");

// Ensure clean test database directory before server starts
if (fs.existsSync(DATA_DIR)) {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
fs.mkdirSync(DATA_DIR, { recursive: true });

export default defineConfig({
  testDir: "./e2e",
  timeout: 30 * 1000,
  expect: {
    timeout: 8000,
  },
  fullyParallel: false,
  workers: 1, // Single worker avoids database write collisions
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
  },
  webServer: {
    command: "bun server/server.ts",
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 15 * 1000,
    env: {
      PORT: String(PORT),
      HOST: "127.0.0.1",
      AUTH_PASSWORD: "test-e2e-password",
      DATA_DIR: DATA_DIR,
      STATIC_DIR: STATIC_DIR,
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
