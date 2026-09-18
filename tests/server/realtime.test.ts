import { rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
  createRequestHandler,
  createRuntime,
  createServerConfig,
  type ServerRuntime,
} from "../../server/server";
import {
  createRealtimeHub,
  REALTIME_PATH,
  type RealtimeSocketData,
} from "../../server/realtime";

const runtimes: ServerRuntime[] = [];
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
  it("publishes scene changes to the subscribed scene topic", async () => {
    const root = Bun.env.TEMP || Bun.env.TMP || ".";
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
        if (payload.type === "scene_changed") {
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
