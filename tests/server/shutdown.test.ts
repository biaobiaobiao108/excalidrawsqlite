import { describe, expect, it } from "bun:test";

import {
  createShutdownSignalHandler,
  shutdownServer,
} from "../../server/server";

const createRuntimeStub = () => {
  const calls: string[] = [];
  const runtime = {
    db: {
      run: (sql: string) => calls.push(sql),
      close: () => calls.push("close"),
    },
  } as any;
  return { calls, runtime };
};

describe("server shutdown", () => {
  it("waits for a graceful stop before checkpointing and closing SQLite", async () => {
    const { calls, runtime } = createRuntimeStub();
    const stopCalls: boolean[] = [];
    let watcherClosed = 0;

    const result = await shutdownServer({
      server: {
        stop: async (force = false) => {
          stopCalls.push(force);
        },
      },
      runtime,
      closeDevWatcher: () => {
        watcherClosed += 1;
      },
      timeoutMs: 50,
    });

    expect(result).toEqual({ forced: false });
    expect(stopCalls).toEqual([false]);
    expect(watcherClosed).toBe(1);
    expect(calls).toEqual(["PRAGMA wal_checkpoint(TRUNCATE);", "close"]);
  });

  it("forces connection shutdown after the drain timeout without touching SQLite", async () => {
    const { calls, runtime } = createRuntimeStub();
    const stopCalls: boolean[] = [];

    const result = await shutdownServer({
      server: {
        stop: async (force = false) => {
          stopCalls.push(force);
          if (!force) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        },
      },
      runtime,
      timeoutMs: 10,
    });

    expect(result).toEqual({ forced: true });
    expect(stopCalls).toEqual([false, true]);
    expect(calls).toEqual([]);
  });

  it("handles repeated shutdown signals only once", async () => {
    let shutdownCalls = 0;
    let resolveShutdown!: (result: { forced: boolean }) => void;
    const exitCodes: number[] = [];
    const shutdown = () => {
      shutdownCalls += 1;
      return new Promise<{ forced: boolean }>((resolve) => {
        resolveShutdown = resolve;
      });
    };
    const handleShutdown = createShutdownSignalHandler(shutdown, (code) => {
      exitCodes.push(code);
    });

    handleShutdown();
    handleShutdown();
    expect(shutdownCalls).toBe(1);

    resolveShutdown({ forced: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exitCodes).toEqual([0]);
  });
});
