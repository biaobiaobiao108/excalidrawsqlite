import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { createFullBackup } from "../../server/backup";
import { createServerConfig } from "../../server/config";
import {
  cleanupOrphanedFiles,
  stageRequestBodyToFile,
  upsertStagedFile,
} from "../../server/files";
import { createRuntime } from "../../server/runtime";

import type { ServerRuntime } from "../../server/types";

const resources: Array<{ runtime: ServerRuntime; directory: string }> = [];

const setup = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "storage-lifecycle-"));
  const runtime = createRuntime({
    dbPath: path.join(directory, "excalidraw.db"),
    filesDir: path.join(directory, "files"),
    config: createServerConfig({ ALLOW_ANONYMOUS: "true" }),
  });
  resources.push({ runtime, directory });
  return runtime;
};

const upload = async (
  runtime: ServerRuntime,
  id: string,
  data: Uint8Array,
  version?: number,
) => {
  const prepared = await stageRequestBodyToFile(
    runtime,
    id,
    new Request(`http://localhost/api/files/${id}`, {
      method: "PUT",
      body: Uint8Array.from(data),
    }),
  );
  return upsertStagedFile(runtime, id, "image/png", prepared, undefined, version);
};

afterEach(async () => {
  for (const { runtime, directory } of resources.splice(0)) {
    runtime.db.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("storage lifecycle", () => {
  it("accepts a complete backup at its exact archive size limit", async () => {
    const runtime = await setup();
    await upload(runtime, "backup_image", new Uint8Array(1024 * 1024).fill(5));
    const first = await createFullBackup(runtime, "initial");
    runtime.config.maxBackupBytes = first.size;
    await first.cleanup();

    const backup = await createFullBackup(runtime, "exact-limit");
    expect(backup.size).toBe(runtime.config.maxBackupBytes);
    await backup.cleanup();

    runtime.config.maxBackupBytes -= 1;
    await expect(createFullBackup(runtime, "over-limit")).rejects.toMatchObject({
      status: 413,
      code: "BACKUP_TOO_LARGE",
    });
    expect(runtime.activeBackupArtifacts.size).toBe(0);
    expect(
      (await fs.readdir(path.dirname(runtime.dbPath))).filter(
        (name) =>
          name.startsWith("excalidraw-backup-") ||
          name.startsWith("excalidraw-full-backup-"),
      ),
    ).toEqual([]);
  });

  it("protects a successfully reuploaded old orphan from immediate GC", async () => {
    const runtime = await setup();
    const data = new Uint8Array([1, 2, 3]);
    await upload(runtime, "reused_image", data);
    runtime.db.run("UPDATE files SET updated_at = ? WHERE id = ?", [
      Date.now() - 25 * 60 * 60 * 1000,
      "reused_image",
    ]);
    const beforeUpload = Date.now();
    const result = await upload(runtime, "reused_image", data);
    expect(result.updatedAt).toBeGreaterThanOrEqual(beforeUpload);

    await cleanupOrphanedFiles(runtime);
    expect(
      runtime.db.query("SELECT id FROM files WHERE id = ?").get("reused_image"),
    ).not.toBeNull();
    expect(
      new Uint8Array(
        await Bun.file(path.join(runtime.filesDir, "reused_image")).arrayBuffer(),
      ),
    ).toEqual(data);
  });

  it("preserves explicit thumbnail versions during identical uploads", async () => {
    const runtime = await setup();
    const data = new Uint8Array([1, 2, 3]);
    const version = Date.now() - 1000;
    await upload(runtime, "thumbnail_versioned", data, version);
    expect(
      (await upload(runtime, "thumbnail_versioned", data, version - 1)).updatedAt,
    ).toBe(version);
    expect(
      (await upload(runtime, "thumbnail_versioned", data, version + 1)).updatedAt,
    ).toBe(version + 1);
  });
});
