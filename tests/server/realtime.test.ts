import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
  createRequestHandler,
  createRuntime,
  createServerConfig,
  type LocalServerRuntime,
} from "../../server/server";
import {
  createRealtimeHub,
  REALTIME_PATH,
  type RealtimeSocketData,
} from "../../server/realtime";

const runtimes: LocalServerRuntime[] = [];
const directories: string[] = [];

const request = (
  handler: ReturnType<typeof createRequestHandler>,
  pathname: string,
  init: RequestInit = {},
) => handler(new Request(`http://localhost${pathname}`, init));

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    runtime.db.close();
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("native websocket realtime", () => {
  it("reports a permanently deleted scene when its subscriber reconnects", async () => {
    const directory = path.join(
      os.tmpdir(),
      `excalidraw-realtime-test-${crypto.randomUUID()}`,
    );
    const runtime = createRuntime({
      dbPath: path.join(directory, "excalidraw.db"),
      filesDir: path.join(directory, "files"),
      config: createServerConfig({
        NODE_ENV: "test",
        AUTH_PASSWORD: "",
        ALLOW_ANONYMOUS: "true",
      }),
    });
    runtimes.push(runtime);
    directories.push(directory);
    const handler = createRequestHandler(runtime);
    const created = await request(handler, "/api/scenes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "scene_removed", name: "断线画板" }),
    });
    expect(created.status).toBe(201);
    const removed = await request(
      handler,
      "/api/scenes/scene_removed?permanent=true",
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);

    const realtime = createRealtimeHub(runtime);
    const server = Bun.serve<RealtimeSocketData>({
      port: 0,
      fetch: (req, currentServer) => realtime.upgrade(req, currentServer),
      websocket: realtime.websocket,
    });
    realtime.attachServer(server);
    const websocket = new WebSocket(
      `ws://127.0.0.1:${server.port}${REALTIME_PATH}?scene_id=scene_removed`,
    );
    try {
      const payload = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("WebSocket reconciliation timeout")),
          2_000,
        );
        websocket.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data));
          if (message.type === "scene_changed") {
            clearTimeout(timeout);
            resolve(message);
          }
        });
        websocket.addEventListener("error", () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket connection failed"));
        });
      });
      expect(payload).toMatchObject({
        type: "scene_changed",
        sceneId: "scene_removed",
        revision: 0,
        changeKind: "deleted",
      });
    } finally {
      websocket.close();
      await server.stop(true);
    }
  });

  it("publishes scene changes to the subscribed scene topic", async () => {
    const root = os.tmpdir();
    const directory = path.join(
      root,
      `excalidraw-realtime-test-${crypto.randomUUID()}`,
    );
    const runtime = createRuntime({
      dbPath: path.join(directory, "excalidraw.db"),
      filesDir: path.join(directory, "files"),
      config: createServerConfig({
        NODE_ENV: "test",
        AUTH_PASSWORD: "",
        ALLOW_ANONYMOUS: "true",
      }),
    });
    runtimes.push(runtime);
    directories.push(directory);
    const handler = createRequestHandler(runtime);
    const realtime = createRealtimeHub(runtime);
    runtime.realtime = realtime.publisher;
    const server = Bun.serve<RealtimeSocketData>({
      port: 0,
      fetch: (req, currentServer) => {
        if (new URL(req.url).pathname === REALTIME_PATH) {
          return realtime.upgrade(req, currentServer);
        }
        return handler(req);
      },
      websocket: realtime.websocket,
    });
    realtime.attachServer(server);

    const websocket = new WebSocket(
      `ws://127.0.0.1:${server.port}${REALTIME_PATH}?scene_id=scene_realtime`,
    );
    const openPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("WebSocket open timeout")),
        2_000,
      );
      websocket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      websocket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket connection failed"));
      });
    });
    const eventPromise = new Promise<{
      type: string;
      sceneId?: string;
      revision?: number;
    }>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("WebSocket event timeout")),
        2_000,
      );
      websocket.addEventListener("message", (event) => {
        const payload = JSON.parse(String(event.data)) as {
          type: string;
          sceneId?: string;
          revision?: number;
        };
        if (payload.type === "scene_changed" && payload.revision === 1) {
          clearTimeout(timeout);
          resolve(payload);
        }
      });
      websocket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket connection failed"));
      });
    });

    try {
      await openPromise;
      const response = await request(handler, "/api/scenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "scene_realtime",
          name: "实时同步",
          elements: [],
          appState: {},
        }),
      });
      expect(response.status).toBe(201);
      await expect(eventPromise).resolves.toMatchObject({
        type: "scene_changed",
        sceneId: "scene_realtime",
        revision: 1,
      });
    } finally {
      websocket.close();
      await server.stop(true);
    }
  });
});
