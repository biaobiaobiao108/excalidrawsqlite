import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { createServerConfig } from "../../server/config";
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
