import type { OrderedExcalidrawElement } from "@excalidraw/element/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CloudApiError } from "../data/cloudStorage";
import { CloudSaveQueue, type CloudSaveSnapshot } from "../data/cloudSync";

const makeSnapshot = (name: string): CloudSaveSnapshot => ({
  sceneId: "scene-1",
  name,
  elements: [] as OrderedExcalidrawElement[],
  appState: { viewBackgroundColor: "#fff", gridSize: null },
  files: {},
});

describe("cloud save queue", () => {
  const saveCloudScene =
    vi.fn() as typeof import("../data/cloudStorage").saveCloudScene;
  const saveFilesToCloud =
    vi.fn() as typeof import("../data/cloudStorage").saveFilesToCloud;

  beforeEach(() => {
    vi.useFakeTimers();
    saveFilesToCloud.mockReset().mockResolvedValue();
    saveCloudScene.mockReset().mockResolvedValue({
      success: true,
      id: "scene-1",
      updated_at: 2,
      revision: 2,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uploads attachments before the scene and keeps only the newest pending snapshot", async () => {
    const calls: string[] = [];
    saveFilesToCloud.mockImplementation(async () => {
      calls.push("files");
    });
    let releaseFirstSave!: (value: {
      success: true;
      id: string;
      updated_at: number;
      revision: number;
    }) => void;
    saveCloudScene
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirstSave = resolve;
          }),
      )
      .mockImplementation(async (id, data) => {
        calls.push(`scene:${data.name}`);
        return {
          success: true,
          id,
          updated_at: 3,
          revision: 3,
        };
      });
    const queue = new CloudSaveQueue(
      {
        onAuthRequired: vi.fn(),
        onConflict: vi.fn(),
        onError: vi.fn(),
      },
      { saveCloudScene, saveFilesToCloud },
    );

    queue.enqueue(makeSnapshot("first"));
    await vi.advanceTimersByTimeAsync(1000);
    queue.enqueue(makeSnapshot("latest"));
    releaseFirstSave({
      success: true,
      id: "scene-1",
      updated_at: 2,
      revision: 2,
    });
    await vi.runAllTimersAsync();

    expect(calls).toEqual(["files", "files", "scene:latest"]);
    expect(saveCloudScene).toHaveBeenCalledTimes(2);
    queue.dispose();
  });

  it("pauses on auth failure and resumes the pending snapshot after authentication", async () => {
    const onAuthRequired = vi.fn();
    saveCloudScene
      .mockRejectedValueOnce(new CloudApiError("未授权", 401, "UNAUTHORIZED"))
      .mockResolvedValueOnce({
        success: true,
        id: "scene-1",
        updated_at: 2,
        revision: 2,
      });
    const queue = new CloudSaveQueue(
      {
        onAuthRequired,
        onConflict: vi.fn(),
        onError: vi.fn(),
      },
      { saveCloudScene, saveFilesToCloud },
    );

    queue.enqueue(makeSnapshot("pending"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(onAuthRequired).toHaveBeenCalledWith("scene-1");

    queue.resumeAfterAuth("scene-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(saveCloudScene).toHaveBeenCalledTimes(2);
    queue.dispose();
  });
});
