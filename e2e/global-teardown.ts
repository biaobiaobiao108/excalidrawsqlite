import fs from "node:fs";
import path from "node:path";

export default async () => {
  const dataDir = path.resolve(__dirname, "../data-e2e");

  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Keep teardown best effort if SQLite is still releasing file handles.
  }
};
