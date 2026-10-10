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
          revision: scene.revision,
          changeKind: operation.changeKind,
        }));
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
