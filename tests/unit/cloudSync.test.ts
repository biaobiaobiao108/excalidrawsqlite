import { describe, expect, it } from "bun:test";

import {
  CloudSaveQueue,
  type CloudSaveSnapshot,
} from "../../excalidraw-app/data/cloudSync";
import { CloudApiError } from "../../excalidraw-app/data/cloudStorage";

const snapshot = (name: string): CloudSaveSnapshot => ({
  sceneId: "scene",
  name,
  elements: [],
  appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
  files: {},
  baseRevision: 1,
});

const callbacks = {
  onAuthRequired: () => {},
  onConflict: () => {},
  onError: () => {},
};

describe("cloud save queue", () => {
  it("keeps the latest edit when an in-flight save requires authentication", async () => {
    const savedNames: string[] = [];
    let signalFirstSave!: () => void;
    let rejectFirstSave!: (reason: Error) => void;
    const firstSaveStarted = new Promise<void>((resolve) => {
      signalFirstSave = resolve;
    });
    const queue = new CloudSaveQueue(callbacks, {
      saveFilesToCloud: async () => {},
      saveCloudScene: async (id, data) => {
        savedNames.push(data.name || "");
        if (savedNames.length === 1) {
          signalFirstSave();
          await new Promise<never>((_, reject) => {
            rejectFirstSave = reject;
          });
        }
        return { success: true, id, updated_at: Date.now(), revision: 2 };
      },
    });

    queue.enqueue(snapshot("older"));
    const firstFlush = queue.flush("scene");
    await firstSaveStarted;
    queue.enqueue(snapshot("newer"));
    rejectFirstSave(new CloudApiError("session expired", 401, "AUTH_REQUIRED"));

    expect(await firstFlush).toBe("auth");
    queue.resumeAfterAuth("scene");
    expect(await queue.flush("scene")).toBe("saved");
    expect(savedNames).toEqual(["older", "newer"]);
    queue.cancel("scene");
  });

  it("keeps the latest edit after an in-flight save exhausts retries", async () => {
    const savedNames: string[] = [];
    let signalFirstSave!: () => void;
    const firstSaveStarted = new Promise<void>((resolve) => {
      signalFirstSave = resolve;
    });
    const queue = new CloudSaveQueue(callbacks, {
      saveFilesToCloud: async () => {},
      saveCloudScene: async (id, data) => {
        savedNames.push(data.name || "");
        if (savedNames.length === 1) {
          signalFirstSave();
        }
        if (data.name === "older") {
          throw new Error("network unavailable");
        }
        return { success: true, id, updated_at: Date.now(), revision: 2 };
      },
    });

    queue.enqueue(snapshot("older"));
    const firstFlush = queue.flush("scene");
    await firstSaveStarted;
    queue.enqueue(snapshot("newer"));

    expect(await firstFlush).toBe("error");
    expect(await queue.flush("scene")).toBe("saved");
    expect(savedNames).toEqual(["older", "older", "older", "newer"]);
    queue.cancel("scene");
  });

  it("does not restore or report a snapshot when a scene is cancelled in flight", async () => {
    for (const failure of [
      new CloudApiError("session expired", 401, "AUTH_REQUIRED"),
      new CloudApiError("scene changed", 409, "REVISION_CONFLICT"),
      new Error("network unavailable"),
    ]) {
      let signalSaveStarted!: () => void;
      let rejectSave!: (reason: Error) => void;
      const saveStarted = new Promise<void>((resolve) => {
        signalSaveStarted = resolve;
      });
      const callbacksSeen = { auth: 0, conflict: 0, error: 0 };
      const queue = new CloudSaveQueue(
        {
          onAuthRequired: () => callbacksSeen.auth++,
          onConflict: () => callbacksSeen.conflict++,
          onError: () => callbacksSeen.error++,
        },
        {
          saveFilesToCloud: async () => {},
          saveCloudScene: async () => {
            signalSaveStarted();
            await new Promise<never>((_, reject) => {
              rejectSave = reject;
            });
            return {
              success: true,
              id: "scene",
              updated_at: Date.now(),
              revision: 2,
            };
          },
        },
      );

      queue.enqueue(snapshot("cancelled"));
      const flush = queue.flush("scene");
      await saveStarted;
      queue.cancel("scene");
      rejectSave(failure);

      expect(await flush).toBe("idle");
      expect(queue.hasPending("scene")).toBe(false);
      expect(queue.getMemoryStats().snapshotCount).toBe(0);
      expect(callbacksSeen).toEqual({ auth: 0, conflict: 0, error: 0 });
    }
  });
});
