import { readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { createServerConfig } from "../../server/config";
import { stageRequestBodyToFile, upsertStagedFile, withStorageMutationLock } from "../../server/files";
import { createRequestHandler } from "../../server/routes";
import { createRuntime } from "../../server/runtime";

import type { SceneRealtimeEvent, ServerRuntime } from "../../server/types";

const resources: Array<{ runtime: ServerRuntime; directory: string }> = [];

const setup = (env: Record<string, string> = {}) => {
  const directory = path.join(os.tmpdir(), `excalidraw-routes-${crypto.randomUUID()}`);
  const runtime = createRuntime({
    dbPath: path.join(directory, "database.db"),
    filesDir: path.join(directory, "files"),
    config: createServerConfig({ NODE_ENV: "test", ALLOW_ANONYMOUS: "true", ...env }),
  });
  resources.push({ runtime, directory });
  const handler = createRequestHandler(runtime);
  const request = (pathname: string, init: RequestInit = {}) =>
    handler(new Request(`http://localhost${pathname}`, init));
  const json = (pathname: string, body: unknown, method = "POST") =>
    request(pathname, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { runtime, request, json };
};

afterEach(async () => {
  for (const { runtime, directory } of resources.splice(0)) {
    runtime.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

describe("route failure and realtime regressions", () => {
  it("keeps attachment bytes and ETag stable while the file is replaced", async () => {
    const { request } = setup();
    const original = new Uint8Array(512 * 1024);
    const replacement = new Uint8Array(original.length);
    for (let index = 0; index < original.length; index += 1) {
      original[index] = index % 251;
      replacement[index] = 255 - original[index];
    }

    const upload = (bytes: Uint8Array) => request("/api/files/racing-file", {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes.buffer as ArrayBuffer,
    });
    expect((await upload(original)).status).toBe(201);

    const oldDownload = await request("/api/files/racing-file");
    const oldEtag = oldDownload.headers.get("etag");
    expect(oldEtag).toBeTruthy();
    expect((await upload(replacement)).status).toBe(201);

    const downloadedBytes = new Uint8Array(await oldDownload.arrayBuffer());
    expect(downloadedBytes).toEqual(original);
    expect(downloadedBytes.byteLength).toBe(original.byteLength);
    expect(oldDownload.headers.get("etag")).toBe(oldEtag);

    const newDownload = await request("/api/files/racing-file");
    expect(new Uint8Array(await newDownload.arrayBuffer())).toEqual(replacement);
  });

  it("updates referenced scenes when an attachment ID is replaced", async () => {
    const { runtime, json, request } = setup();
    const upload = (bytes: Uint8Array) => {
      const body = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(body).set(bytes);
      return request("/api/files/shared_asset", {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body,
      });
    };
    const originalBytes = new Uint8Array([1, 2, 3]);
    const replacementBytes = new Uint8Array([9, 8, 7, 6]);
    expect((await upload(originalBytes)).status).toBe(201);

    const image = { id: "shared_asset_element", type: "image", fileId: "shared_asset" };
    for (const id of ["asset_scene_a", "asset_scene_b"]) {
      expect((await json("/api/scenes", { id, elements: [image] })).status).toBe(201);
    }
    expect((await request("/api/scenes/asset_scene_a/thumbnail", {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array([5, 5, 5]),
    })).status).toBe(200);

    const events: SceneRealtimeEvent[] = [];
    runtime.realtime = {
      publishSceneChanged: (event) => { events.push(event); },
      publishWorkspaceChanged: () => {},
    };
    const oldScene = await request("/api/scenes/asset_scene_a");
    const oldSceneEtag = oldScene.headers.get("etag");
    const newFileResponse = await upload(replacementBytes);
    expect(newFileResponse.status).toBe(201);
    expect(newFileResponse.headers.get("etag")).not.toBeNull();
    expect(events).toHaveLength(2);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ sceneId: "asset_scene_a", revision: 2, changeKind: "content" }),
      expect.objectContaining({ sceneId: "asset_scene_b", revision: 2, changeKind: "content" }),
    ]));

    const updatedSceneResponse = await request("/api/scenes/asset_scene_a");
    expect(updatedSceneResponse.headers.get("etag")).not.toBe(oldSceneEtag);
    expect(await updatedSceneResponse.json()).toMatchObject({ revision: 2, thumbnail_file_id: null });
    expect((await request("/api/scenes/asset_scene_b")).status).toBe(200);
    expect((await json("/api/scenes/asset_scene_a", {
      name: "陈旧写入",
      baseRevision: 1,
    }, "PATCH")).status).toBe(409);
    expect(new Uint8Array(await (await request("/api/files/shared_asset")).arrayBuffer())).toEqual(replacementBytes);

    events.length = 0;
    expect((await upload(replacementBytes)).status).toBe(201);
    expect(events).toHaveLength(0);
    expect(await (await request("/api/scenes/asset_scene_a")).json()).toMatchObject({ revision: 2 });
  });

  it("rolls back attachment replacement when an affected scene cannot be updated", async () => {
    const { runtime, json, request } = setup();
    const upload = (bytes: Uint8Array) => {
      const body = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(body).set(bytes);
      return request("/api/files/rollback_asset", {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body,
      });
    };
    const originalBytes = new Uint8Array([1, 2, 3]);
    const replacementBytes = new Uint8Array([4, 5, 6, 7]);
    expect((await upload(originalBytes)).status).toBe(201);
    expect((await json("/api/scenes", {
      id: "asset_rollback",
      elements: [{ id: "rollback_image", type: "image", fileId: "rollback_asset" }],
    })).status).toBe(201);
    const thumbnailResponse = await request("/api/scenes/asset_rollback/thumbnail", {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array([8, 8, 8]),
    });
    expect(thumbnailResponse.status).toBe(200);
    const { thumbnail_file_id: thumbnailId } = await thumbnailResponse.json() as {
      thumbnail_file_id: string;
    };
    const fileRow = runtime.db.query("SELECT * FROM files WHERE id = ?").get("rollback_asset");
    const sceneRow = runtime.db.query("SELECT * FROM scenes WHERE id = ?").get("asset_rollback");
    runtime.db.run(`CREATE TRIGGER fail_referenced_scene_update
      BEFORE UPDATE OF revision ON scenes
      WHEN OLD.id = 'asset_rollback'
      BEGIN SELECT RAISE(ABORT, 'test scene update failure'); END`);

    const response = await upload(replacementBytes);
    expect(response.status).toBe(500);
    expect(runtime.db.query("SELECT * FROM files WHERE id = ?").get("rollback_asset")).toEqual(fileRow);
    expect(runtime.db.query("SELECT * FROM scenes WHERE id = ?").get("asset_rollback")).toEqual(sceneRow);
    expect(new Uint8Array(await (await request("/api/files/rollback_asset")).arrayBuffer())).toEqual(originalBytes);
    expect((await readdir(runtime.filesDir)).sort()).toEqual(
      ["rollback_asset", thumbnailId].sort(),
    );
    expect(runtime.bodyMemoryBudget.getStats().currentBytes).toBe(0);
  });

  it("rejects partial scene saves when stored tags are corrupt but allows explicit repair", async () => {
    const { runtime, json } = setup();
    expect((await json("/api/scenes", { id: "corrupt_tags", tags: ["原标签"] })).status).toBe(201);
    const stored = () => runtime.db.query("SELECT * FROM scenes WHERE id = ?").get("corrupt_tags");

    for (const malformed of ["", "null", "{}", "[1]"]) {
      runtime.db.run("UPDATE scenes SET tags_json = ? WHERE id = ?", [malformed, "corrupt_tags"]);
      const before = stored();
      for (const [method, body] of [
        ["PATCH", { name: "不能丢标签" }],
        ["PUT", { name: "不能丢标签" }],
      ] as const) {
        const response = await json("/api/scenes/corrupt_tags", body, method);
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ code: "CORRUPT_SCENE" });
        expect(stored()).toEqual(before);
      }

      const repaired = await json("/api/scenes/corrupt_tags", { tags: ["已修复"] }, "PATCH");
      expect(repaired.status).toBe(200);
      expect(await repaired.json()).toMatchObject({ tags: ["已修复"] });
      expect(stored()).toMatchObject({ tags_json: '["已修复"]' });
    }
  });

  it("rejects a deleted target folder when scene creation or saving waits for storage", async () => {
    for (const method of ["POST", "PUT"] as const) {
      const { runtime, json, request } = setup();
      const folderResponse = await json("/api/folders", { name: "待删除文件夹" });
      const { id: folderId } = await folderResponse.json() as { id: string };
      if (method === "PUT") {
        expect((await json("/api/scenes", { id: "folder_race", name: "原画板" })).status).toBe(201);
      }
      const stored = () => runtime.db.query("SELECT * FROM scenes WHERE id = ?").get("folder_race");
      const before = stored();
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => { started = resolve; });
      const storageTask = withStorageMutationLock(runtime, async () => {
        started();
        await new Promise<void>((resolve) => { release = resolve; });
      });
      await entered;
      const saving = json(
        method === "POST" ? "/api/scenes" : "/api/scenes/folder_race",
        { id: "folder_race", name: "新画板", folder_id: folderId, elements: [], appState: {} },
        method,
      );
      try {
        // Let JSON parsing and the initial folder validation reach the held
        // storage queue before deleting the target folder.
        await Bun.sleep(0);
        expect((await request(`/api/folders/${folderId}`, { method: "DELETE" })).status).toBe(200);
      } finally {
        release();
        await storageTask;
      }
      const response = await saving;
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "FOLDER_NOT_FOUND" });
      expect(stored()).toEqual(before);
      expect(runtime.bodyMemoryBudget.getStats().currentBytes).toBe(0);
      if (method === "PUT") {
        expect((await json("/api/scenes/folder_race", { name: "正常保存" }, "PUT")).status).toBe(200);
      }
    }
  });

  it("rejects invalid stored revisions across reads and mutations without changing the board", async () => {
    const { runtime, json, request } = setup();
    await json("/api/scenes", { id: "corrupt_revision" });
    const stored = () => runtime.db.query("SELECT * FROM scenes WHERE id = ?").get("corrupt_revision");
    for (const revision of [0, -1, 1.5]) {
      runtime.db.run("UPDATE scenes SET revision = ? WHERE id = ?", [revision, "corrupt_revision"]);
      const before = stored();
      const operations = [
        () => request("/api/scenes/corrupt_revision"),
        () => request("/api/scenes/corrupt_revision/summary"),
        () => request("/api/scenes/corrupt_revision/thumbnail", {
          method: "PUT", headers: { "Content-Type": "image/png" }, body: new Uint8Array([1]),
        }),
        () => request("/api/scenes/corrupt_revision/thumbnail", { method: "DELETE" }),
        () => json("/api/scenes/corrupt_revision", { name: "禁止写入" }, "PATCH"),
        () => json("/api/scenes/corrupt_revision", { elements: [], appState: {} }, "PUT"),
        () => request("/api/scenes/corrupt_revision", { method: "DELETE" }),
        () => json("/api/scenes/corrupt_revision/restore", {}),
        () => json("/api/scenes/batch", { scenes: [{ id: "corrupt_revision", revision: 1 }], deleted: true }, "PATCH"),
      ];
      for (const operation of operations) {
        const response = await operation();
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ code: "CORRUPT_SCENE" });
        expect(stored()).toEqual(before);
      }
    }
  });

  it("preserves omitted valid content on partial saves and rejects corrupt stored content atomically", async () => {
    const { runtime, json, request } = setup();
    const elements = [{ id: "preserved_shape", type: "rectangle" }];
    const appState = { viewBackgroundColor: "#abc" };
    await json("/api/scenes", { id: "partial_content", elements, appState });
    expect((await json("/api/scenes/partial_content", { name: "只改名" }, "PUT")).status).toBe(200);
    expect(await (await request("/api/scenes/partial_content")).json()).toMatchObject({ elements, appState });
    const stored = () => runtime.db.query("SELECT * FROM scenes WHERE id = ?").get("partial_content");
    for (const column of ["elements", "app_state"] as const) {
      for (const malformed of ["", "null", column === "elements" ? "{}" : "[]"]) {
        runtime.db.run(`UPDATE scenes SET ${column} = ? WHERE id = ?`, [malformed, "partial_content"]);
        const before = stored();
        for (const operation of [
          () => request("/api/scenes/partial_content"),
          () => json("/api/scenes/partial_content", { name: "禁止丢失内容" }, "PUT"),
        ]) {
          const response = await operation();
          expect(response.status).toBe(500);
          expect(await response.json()).toMatchObject({ code: "CORRUPT_SCENE" });
          expect(stored()).toEqual(before);
        }
        // Explicit replacement remains available; omitted fields never receive guessed defaults.
        expect((await json("/api/scenes/partial_content", { elements, appState }, "PUT")).status).toBe(200);
      }
    }
  });

  it("invalidates old revisions across trash restoration and preserves repeated-state noops", async () => {
    const { runtime, json, request } = setup();
    await json("/api/scenes", { id: "trash_lifecycle" });
    const events: SceneRealtimeEvent[] = [];
    runtime.realtime = {
      publishSceneChanged: (event) => { events.push(event); },
      publishWorkspaceChanged: () => {},
    };
    const state = () => runtime.db.query("SELECT revision, updated_at, deleted_at FROM scenes WHERE id = ?").get("trash_lifecycle");
    expect(await (await request("/api/scenes/trash_lifecycle", { method: "DELETE" })).json()).toMatchObject({ revision: 2 });
    const deleted = state();
    expect(await (await request("/api/scenes/trash_lifecycle", { method: "DELETE" })).json()).toMatchObject({ revision: 2, noop: true });
    expect(state()).toEqual(deleted);
    expect(await (await json("/api/scenes/batch", { scenes: [{ id: "trash_lifecycle", revision: 2 }], deleted: true }, "PATCH")).json()).toMatchObject({ noop: true });
    expect(state()).toEqual(deleted);
    expect(events).toHaveLength(1);
    expect(await (await request("/api/scenes/trash_lifecycle/restore", { method: "POST" })).json()).toMatchObject({ revision: 3 });
    const restored = state();
    expect(await (await request("/api/scenes/trash_lifecycle/restore", { method: "POST" })).json()).toMatchObject({ revision: 3, noop: true });
    expect(state()).toEqual(restored);
    expect(await (await json("/api/scenes/batch", { scenes: [{ id: "trash_lifecycle", revision: 3 }], deleted: false }, "PATCH")).json()).toMatchObject({ noop: true });
    expect(state()).toEqual(restored);
    expect(events.map((event) => event.revision)).toEqual([2, 3]);
    expect((await json("/api/scenes/trash_lifecycle", { name: "stale write", baseRevision: 1 }, "PATCH")).status).toBe(409);
    expect((await json("/api/scenes/batch", { scenes: [{ id: "trash_lifecycle", revision: 1 }], deleted: true }, "PATCH")).status).toBe(409);
    expect(state()).toEqual(restored);
  });

  it("invalidates previews only on content changes and rejects stale repair uploads", async () => {
    const { json, request } = setup();
    await json("/api/scenes", { id: "repair_preview", elements: [{ id: "shape", type: "rectangle", x: 0, y: 0, width: 100, height: 100 }] });
    const upload = (revision: number) => request(`/api/scenes/repair_preview/thumbnail?revision=${revision}`, {
      method: "PUT", headers: { "Content-Type": "image/png" }, body: new Uint8Array([1, 2, 3]),
    });
    expect((await upload(1)).status).toBe(200);
    const initial = await (await request("/api/scenes/repair_preview")).json() as { thumbnail_file_id: string };
    expect(initial.thumbnail_file_id).toBeTruthy();
    await json("/api/scenes/repair_preview", { name: "renamed", baseRevision: 1 }, "PUT");
    expect(await (await request("/api/scenes/repair_preview")).json()).toMatchObject({ thumbnail_file_id: initial.thumbnail_file_id });
    await json("/api/scenes/repair_preview", { elements: [{ id: "new", type: "rectangle" }], baseRevision: 2 }, "PUT");
    expect(await (await request("/api/scenes/repair_preview")).json()).toMatchObject({ thumbnail_file_id: null, revision: 3 });
    expect((await upload(1)).status).toBe(409);
    expect(await (await request("/api/scenes/repair_preview")).json()).toMatchObject({ thumbnail_file_id: null });
    expect((await upload(3)).status).toBe(200);
    expect(await (await request("/api/scenes/repair_preview")).json()).toMatchObject({ thumbnail_file_id: initial.thumbnail_file_id });
  });

  it("rejects slow stale thumbnail uploads before replacing stored bytes and cleans staging", async () => {
    for (const explicitRevision of [false, true]) {
      const { runtime, json, request } = setup();
      await json("/api/scenes", { id: "slow_preview", elements: [{ id: "old", type: "rectangle" }] });
      const initial = await request("/api/scenes/slow_preview/thumbnail", {
        method: "PUT", headers: { "Content-Type": "image/png", "X-Thumbnail-Version": "100" },
        body: new Uint8Array([1, 2, 3]),
      });
      const { thumbnail_file_id } = await initial.json() as { thumbnail_file_id: string };
      let finish!: () => void;
      let reading!: () => void;
      const started = new Promise<void>((resolve) => { reading = resolve; });
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          reading();
          return new Promise<void>((resolve) => {
            finish = () => { controller.enqueue(new Uint8Array([4, 5, 6])); controller.close(); resolve(); };
          });
        },
      });
      const upload = request(`/api/scenes/slow_preview/thumbnail${explicitRevision ? "?revision=1" : ""}`, {
        method: "PUT", headers: { "Content-Type": "image/png", "X-Thumbnail-Version": "101" }, body,
      });
      await started;
      try {
        expect((await json("/api/scenes/slow_preview", { elements: [{ id: "new", type: "rectangle" }], baseRevision: 1 }, "PUT")).status).toBe(200);
      } finally {
        finish();
      }
      const rejected = await upload;
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({ code: "REVISION_CONFLICT" });
      expect(await (await request("/api/scenes/slow_preview")).json()).toMatchObject({ revision: 2, thumbnail_file_id: null });
      expect(new Uint8Array(await (await request(`/api/files/${thumbnail_file_id}`)).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
      expect(await readdir(runtime.filesDir)).toEqual([thumbnail_file_id]);
      expect(runtime.bodyMemoryBudget.getStats().currentBytes).toBe(0);
      expect((await request("/api/scenes/slow_preview/thumbnail?revision=2", {
        method: "PUT", headers: { "Content-Type": "image/png", "X-Thumbnail-Version": "102" }, body: new Uint8Array([7]),
      })).status).toBe(200);
      expect(new Uint8Array(await (await request(`/api/files/${thumbnail_file_id}`)).arrayBuffer())).toEqual(new Uint8Array([7]));
      expect((await request("/api/scenes/slow_preview/thumbnail?revision=1", { method: "DELETE" })).status).toBe(409);
      expect(await (await request("/api/scenes/slow_preview")).json()).toMatchObject({ thumbnail_file_id });
    }
  });

  it("rechecks thumbnail revisions after waiting for storage", async () => {
    const { runtime, json, request } = setup();
    await json("/api/scenes", { id: "queued_preview" });
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const storage = withStorageMutationLock(runtime, async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await started;
    const uploading = request("/api/scenes/queued_preview/thumbnail?revision=1", {
      method: "PUT", headers: { "Content-Type": "image/png", "X-Thumbnail-Version": "100" }, body: new Uint8Array([1]),
    });
    try {
      for (let attempt = 0; attempt < 100 && !(await readdir(runtime.filesDir)).some((file) => file.endsWith(".tmp")); attempt++) {
        await Bun.sleep(1);
      }
      expect((await readdir(runtime.filesDir)).some((file) => file.endsWith(".tmp"))).toBe(true);
      await Bun.sleep(1);
      expect((await json("/api/scenes/queued_preview", { name: "changed", baseRevision: 1 }, "PATCH")).status).toBe(200);
    } finally {
      release();
      await storage;
    }
    expect((await uploading).status).toBe(409);
    expect(await readdir(runtime.filesDir)).toEqual([]);
    expect(runtime.db.query("SELECT COUNT(*) AS count FROM files").get()).toEqual({ count: 0 });
  });

  it("rolls back replaced thumbnail bytes when the final write guard detects a scene change", async () => {
    const { runtime, json, request } = setup();
    await json("/api/scenes", { id: "rollback_preview" });
    const uploaded = await request("/api/scenes/rollback_preview/thumbnail", {
      method: "PUT", headers: { "Content-Type": "image/png", "X-Thumbnail-Version": "100" }, body: new Uint8Array([1, 2]),
    });
    const { thumbnail_file_id } = await uploaded.json() as { thumbnail_file_id: string };
    const previous = runtime.db.query("SELECT * FROM files WHERE id = ?").get(thumbnail_file_id);
    const prepared = await stageRequestBodyToFile(runtime, thumbnail_file_id, new Request("http://localhost/upload", {
      method: "PUT", body: new Uint8Array([3, 4]),
    }));
    let checks = 0;
    await expect(upsertStagedFile(runtime, thumbnail_file_id, "image/png", prepared, undefined, 101, () => {
      if (++checks === 2) {
        // The second guard runs after the atomic filesystem replacement.
        runtime.db.run("UPDATE scenes SET revision = revision + 1 WHERE id = ?", ["rollback_preview"]);
        throw new Error("scene changed during filesystem replacement");
      }
    })).rejects.toThrow("scene changed during filesystem replacement");
    expect(checks).toBe(2);
    expect(runtime.db.query("SELECT * FROM files WHERE id = ?").get(thumbnail_file_id)).toEqual(previous);
    expect(new Uint8Array(await (await request(`/api/files/${thumbnail_file_id}`)).arrayBuffer())).toEqual(new Uint8Array([1, 2]));
    expect(await readdir(runtime.filesDir)).toEqual([thumbnail_file_id]);
  });

  it("notifies every open scene after committed batch deletion, restoration and permanent deletion", async () => {
    const { runtime, json } = setup();
    const scenes = [{ id: "batch_a", revision: 1 }, { id: "batch_b", revision: 1 }];
    for (const scene of scenes) {
      expect((await json("/api/scenes", { id: scene.id })).status).toBe(201);
    }
    const events: SceneRealtimeEvent[] = [];
    runtime.realtime = {
      publishSceneChanged: (event) => { events.push(event); },
      publishWorkspaceChanged: () => {},
    };
    for (const operation of [
      { method: "PATCH", deleted: true, changeKind: "deleted" },
      { method: "PATCH", deleted: false, changeKind: "restored" },
      { method: "PATCH", deleted: true, changeKind: "deleted" },
      { method: "DELETE", deleted: true, changeKind: "deleted" },
    ]) {
      events.length = 0;
      const response = await json("/api/scenes/batch", {
        scenes,
        deleted: operation.deleted,
      }, operation.method);
      expect(response.status).toBe(200);
      expect(events).toHaveLength(scenes.length);
      for (const scene of scenes) {
        expect(events).toContainEqual(expect.objectContaining({
          type: "scene_changed",
          sceneId: scene.id,
          revision: scene.revision + (operation.method === "DELETE" ? 0 : 1),
          changeKind: operation.changeKind,
        }));
      }
      if (operation.method !== "DELETE") {
        for (const scene of scenes) scene.revision += 1;
      }
    }
  });

  it("does not publish partial batch deletion when another selected scene is stale", async () => {
    const { runtime, json, request } = setup();
    expect((await json("/api/scenes", { id: "batch_valid" })).status).toBe(201);
    const events: SceneRealtimeEvent[] = [];
    runtime.realtime = {
      publishSceneChanged: (event) => { events.push(event); },
      publishWorkspaceChanged: () => {},
    };
    const response = await json("/api/scenes/batch", {
      scenes: [{ id: "batch_valid", revision: 1 }, { id: "batch_missing", revision: 1 }],
      deleted: true,
    }, "PATCH");
    expect(response.status).toBe(409);
    expect(events).toHaveLength(0);
    expect((await request("/api/scenes/batch_valid")).status).toBe(200);
  });

  it("returns a secured JSON 413 when asynchronous thumbnail staging exceeds the size limit", async () => {
    const { json, request, runtime } = setup({ MAX_FILE_BYTES: "8" });
    expect((await json("/api/scenes", { id: "oversized_thumbnail" })).status).toBe(201);
    const response = await request("/api/scenes/oversized_thumbnail/thumbnail", {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array(9),
    });
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-security-policy")).toContain("script-src");
    expect(await response.json()).toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(runtime.bodyMemoryBudget.getStats().currentBytes).toBe(0);
    expect((await request("/api/scenes/oversized_thumbnail")).status).toBe(200);
  });

  it("normalizes thumbnail deletion failures and preserves the thumbnail", async () => {
    const { runtime, json, request } = setup();
    expect((await json("/api/scenes", { id: "failed_thumbnail_delete" })).status).toBe(201);
    const uploaded = await request("/api/scenes/failed_thumbnail_delete/thumbnail", {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(uploaded.status).toBe(200);
    const { thumbnail_file_id } = await uploaded.json() as { thumbnail_file_id: string };
    runtime.db.run(`CREATE TRIGGER fail_thumbnail_delete BEFORE UPDATE OF thumbnail_file_id ON scenes
      WHEN NEW.thumbnail_file_id IS NULL BEGIN SELECT RAISE(ABORT, 'test deletion failure'); END`);
    const response = await request("/api/scenes/failed_thumbnail_delete/thumbnail", { method: "DELETE" });
    expect(response.status).toBe(500);
    expect(response.headers.get("content-security-policy")).toContain("script-src");
    expect(await response.json()).toEqual({ code: "INTERNAL_ERROR", error: "服务器内部错误" });
    const scene = await request("/api/scenes/failed_thumbnail_delete");
    expect(await scene.json()).toMatchObject({ thumbnail_file_id });
    runtime.db.run("DROP TRIGGER fail_thumbnail_delete");
    expect((await request("/api/scenes/failed_thumbnail_delete/thumbnail", { method: "DELETE" })).status).toBe(200);
  });
});
