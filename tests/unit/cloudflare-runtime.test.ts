import { describe, expect, it } from "bun:test";
import { createCloudflareRuntime, type CloudflareEnv } from "../../server/cloudflare-runtime";

const createEnv = () => {
  const statement = {
    bind() { return this; },
    async first() { return null; },
    async all() { return { success: true, results: [] }; },
    async run() { return { success: true, meta: { changes: 0 } }; },
  };
  const env = {
    DB: { prepare: () => statement, batch: async () => [] },
    ASSETS_BUCKET: {},
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    REALTIME_HUB: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
    ALLOW_ANONYMOUS: "true",
    MAX_FILE_BYTES: "4",
    MAX_SCENE_BODY_BYTES: "4",
    MAX_IN_FLIGHT_BODY_BYTES: "10",
  } as unknown as CloudflareEnv;
  return env;
};

describe("Cloudflare runtime budgets", () => {
  it("shares aggregate body reservations between request runtimes in one isolate", async () => {
    const env = createEnv();
    const context = { waitUntil: () => {} };
    const request = new Request("https://example.test/api/scenes");
    const firstRuntime = createCloudflareRuntime(env, context, request);
    const secondRuntime = createCloudflareRuntime(env, context, request);

    expect(secondRuntime.bodyMemoryBudget).toBe(firstRuntime.bodyMemoryBudget);
    const firstReservation = await firstRuntime.bodyMemoryBudget.acquire(7);
    let secondAcquired = false;
    const secondReservation = secondRuntime.bodyMemoryBudget.acquire(7).then((bytes) => {
      secondAcquired = true;
      return bytes;
    });

    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    firstRuntime.bodyMemoryBudget.release(firstReservation);
    const secondBytes = await secondReservation;
    expect(secondAcquired).toBe(true);
    secondRuntime.bodyMemoryBudget.release(secondBytes);
    expect(firstRuntime.bodyMemoryBudget.getStats().currentBytes).toBe(0);
  });
});
