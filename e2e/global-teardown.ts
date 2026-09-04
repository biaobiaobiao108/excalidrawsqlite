import fs from "node:fs";
import path from "node:path";

export default async () => {
  const dataDir = path.resolve(__dirname, "../data-e2e");

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(dataDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
      if (!fs.existsSync(dataDir)) {
        return;
      }
    } catch {
      // Keep retrying while SQLite releases file handles.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
