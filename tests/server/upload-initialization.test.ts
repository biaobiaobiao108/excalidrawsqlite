import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, spyOn } from "bun:test";

import { createServerConfig } from "../../server/config";
import { stageRequestBodyToFile } from "../../server/files";
import { createRuntime } from "../../server/runtime";
import type { ServerRuntime } from "../../server/types";

const directories: string[] = [];
const runtimes: ServerRuntime[] = [];

const setup = () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "excalidraw-upload-init-"),
  );
  directories.push(directory);
  const runtime = createRuntime({
    dbPath: path.join(directory, "excalidraw.db"),
    filesDir: path.join(directory, "files"),
    config: createServerConfig({ NODE_ENV: "test", MAX_FILE_BYTES: "4096" }),
  });
  runtimes.push(runtime);
  const request = new Request("http://localhost/api/files/test", {
    method: "PUT",
    body: new Uint8Array([1, 2, 3]),
  });
  return { runtime, request };
};

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.db.close();
  }
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("upload initialization cleanup", () => {
  it("releases the budget and removes partial files when opening the writer fails", async () => {
    const { runtime, request } = setup();
    const originalFile = Bun.file;
    const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const fileSpy = spyOn(Bun, "file").mockImplementationOnce(
      (filePath, options) => {
        if (typeof filePath !== "string") {
          throw new Error("Expected an upload temporary path");
        }
        const file = originalFile(filePath, options);
        return Object.assign(file, {
          writer: () => {
            fs.writeFileSync(filePath, "partial");
            throw failure;
          },
        });
      },
    );
    try {
      await expect(
        stageRequestBodyToFile(runtime, "test", request),
      ).rejects.toBe(failure);
      expect(runtime.bodyMemoryBudget.getStats().currentBytes).toBe(0);
      expect(runtime.bodyMemoryBudget.getStats().peakBytes).toBe(4096);
      expect(request.body!.locked).toBe(false);
      expect(fs.readdirSync(runtime.filesDir)).toEqual([]);
    } finally {
      fileSpy.mockRestore();
    }
  });

  it("releases the budget without creating a file when the request body is already locked", async () => {
    const { runtime, request } = setup();
    const reader = request.body!.getReader();
    try {
      await expect(
        stageRequestBodyToFile(runtime, "test", request),
      ).rejects.toBeInstanceOf(TypeError);
      expect(runtime.bodyMemoryBudget.getStats().currentBytes).toBe(0);
      expect(runtime.bodyMemoryBudget.getStats().peakBytes).toBe(4096);
      expect(fs.readdirSync(runtime.filesDir)).toEqual([]);
    } finally {
      reader.releaseLock();
    }
  });
});
