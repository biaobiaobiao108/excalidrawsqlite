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
import { createRequestHandler } from "../../server/routes";

import type { ServerRuntime } from "../../server/types";

const resources: Array<{ runtime: ServerRuntime; directory: string }> = [];

const setup = async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "storage-lifecycle-"),
  );
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
  return upsertStagedFile(
    runtime,
    id,
    "image/png",
    prepared,
    undefined,
    version,
  );
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
    // An oversized archive should be rejected before accessing attachments.
    await fs.rename(
      path.join(runtime.filesDir, "backup_image"),
      path.join(runtime.filesDir, "backup_image.hidden"),
    );
    await expect(createFullBackup(runtime, "over-limit")).rejects.toMatchObject(
      {
        status: 413,
        code: "BACKUP_TOO_LARGE",
      },
    );
    expect(runtime.activeBackupArtifacts.size).toBe(0);
    expect(
      (await fs.readdir(path.dirname(runtime.dbPath))).filter(
        (name) =>
          name.startsWith("excalidraw-backup-") ||
          name.startsWith("excalidraw-full-backup-"),
      ),
    ).toEqual([]);
  });

  it("allocates a separate attachment for a board save without changing shared content", async () => {
    const runtime = await setup();
    const handler = createRequestHandler(runtime);
    const request = (pathname: string, init?: RequestInit) =>
      handler(new Request(`http://localhost${pathname}`, init));
    const json = (method: string, body: unknown) => ({
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await upload(runtime, "shared", new Uint8Array([1]));
    const image = { id: "image", type: "image", fileId: "shared", x: 1 };
    for (const id of ["first", "second"]) {
      expect(
        (await request("/api/scenes", json("POST", { id, elements: [image] })))
          .status,
      ).toBe(201);
    }
    const uploadReplacement = () =>
      request("/api/files/shared", {
        method: "PUT",
        headers: { "Content-Type": "image/png", "X-Preserve-File-Id": "true" },
        body: new Uint8Array([2]),
      });
    const imgFile = (
      (await (await uploadReplacement()).json()) as { file: { id: string } }
    ).file;
    expect(imgFile.id).not.toBe("shared");
    expect(await (await uploadReplacement()).json()).toMatchObject({
      file: { id: imgFile.id },
    });
    expect(
      (
        await request(
          "/api/scenes/first",
          json("PUT", {
            baseRevision: 1,
            elements: [{ ...image, fileId: imgFile.id, x: 25 }],
          }),
        )
      ).status,
    ).toBe(200);
    expect(await (await request("/api/scenes/first")).json()).toMatchObject({
      revision: 2,
      elements: [{ fileId: imgFile.id, x: 25 }],
    });
    expect(await (await request("/api/scenes/second")).json()).toMatchObject({
      revision: 1,
      elements: [{ fileId: "shared", x: 1 }],
    });
    expect(
      new Uint8Array(await (await request("/api/files/shared")).arrayBuffer()),
    ).toEqual(new Uint8Array([1]));
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
        await Bun.file(
          path.join(runtime.filesDir, "reused_image"),
        ).arrayBuffer(),
      ),
    ).toEqual(data);
  });

  it("preserves explicit thumbnail versions during identical uploads", async () => {
    const runtime = await setup();
    const data = new Uint8Array([1, 2, 3]);
    const version = Date.now() - 1000;
    await upload(runtime, "thumbnail_versioned", data, version);
    expect(
      (await upload(runtime, "thumbnail_versioned", data, version - 1))
        .updatedAt,
    ).toBe(version);
    expect(
      (await upload(runtime, "thumbnail_versioned", data, version + 1))
        .updatedAt,
    ).toBe(version + 1);
  });
});
