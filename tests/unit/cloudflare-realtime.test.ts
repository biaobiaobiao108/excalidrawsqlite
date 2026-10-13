import { describe, expect, it } from "bun:test";
import { createServerConfig } from "../../server/config";
import { handleCloudflareRealtimeRequest, RealtimeHub } from "../../server/cloudflare-realtime";
import type { ServerRuntime } from "../../server/types";

const createRuntime = (scene: { revision: number; updated_at: number; deleted_at: number | null } | null) => ({
  config: createServerConfig({ NODE_ENV: "production", ALLOW_ANONYMOUS: "true" }),
  db: {
    query: () => ({ get: async () => scene }),
  },
} as unknown as ServerRuntime);

describe("Cloudflare realtime reconnect sync", () => {
  it("reads the scene after socket acceptance and sends a current-state sync to the Durable Object", async () => {
    const calls: Request[] = [];
    const realtime = {
      fetch: async (request: Request) => {
        calls.push(request);
        return calls.length === 1 ? { status: 101 } as Response : new Response(null, { status: 204 });
      },
    };
    const namespace = {
      idFromName: () => "workspace",
      get: () => realtime,
    };
    const response = await handleCloudflareRealtimeRequest(
      new Request("https://example.test/api/realtime?scene_id=scene_a", {
        headers: { Upgrade: "websocket" },
      }),
      createRuntime({ revision: 8, updated_at: 1234, deleted_at: null }),
      namespace,
    );

    expect(response.status).toBe(101);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0].url).searchParams.get("scene_id")).toBe("scene_a");
    expect(new URL(calls[1].url).pathname).toBe("/sync-scene");
    expect(await calls[1].json()).toEqual({
      sceneId: "scene_a",
      revision: 8,
      updatedAt: 1234,
      changeKind: "content",
    });
  });

  it("delivers current scene state only to sockets subscribed to that scene", async () => {
    const sent: string[] = [];
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      serializeAttachment: () => {},
      deserializeAttachment: () => ({ sceneId: "scene_a" }),
      send: (message: string) => sent.push(message),
      close: () => {},
    };
    const hub = new RealtimeHub({
      acceptWebSocket: () => {},
      getWebSockets: () => [socket as unknown as WebSocket & {
        serializeAttachment(value: { sceneId: string | null }): void;
        deserializeAttachment(): { sceneId?: string | null } | null;
      }],
    });

    const response = await hub.fetch(new Request("https://realtime.internal/sync-scene", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sceneId: "scene_a",
        revision: 8,
        updatedAt: 1234,
        changeKind: "deleted",
      }),
    }));

    expect(response.status).toBe(204);
    expect(sent.map((message) => JSON.parse(message))).toEqual([{
      type: "scene_changed",
      sceneId: "scene_a",
      revision: 8,
      updatedAt: 1234,
      changeKind: "deleted",
    }]);
  });
});
