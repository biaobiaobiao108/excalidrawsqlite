import { describe, expect, it, vi } from "bun:test";

import { LatestThumbnailSaveQueue } from "../data/thumbnailSaveQueue";

type TestSnapshot = { sceneId: string; label: string };

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("LatestThumbnailSaveQueue", () => {
  it("skips superseded snapshots before rendering starts", async () => {
    const queue = new LatestThumbnailSaveQueue<TestSnapshot>();
    const create = vi.fn(async (snapshot: TestSnapshot) => snapshot.label);
    const save = vi.fn(async () => undefined);

    queue.schedule({ sceneId: "scene", label: "old" }, create, save, vi.fn());
    const latestTask = queue.schedule(
      { sceneId: "scene", label: "latest" },
      create,
      save,
      vi.fn(),
    );
    await latestTask;

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ sceneId: "scene", label: "latest" });
    expect(save).toHaveBeenCalledWith("scene", "latest");
  });

  it("writes the latest snapshot after an older upload already in flight", async () => {
    const queue = new LatestThumbnailSaveQueue<TestSnapshot>();
    let resolveOld: (() => void) | undefined;
    const oldUpload = new Promise<void>((resolve) => {
      resolveOld = resolve;
    });
    const saved: string[] = [];
    const create = vi.fn(async (snapshot: TestSnapshot) => snapshot.label);
    const save = vi.fn(async (_sceneId: string, output: string | null) => {
      if (output !== null) {
        saved.push(output);
      }
      if (output === "old") {
        await oldUpload;
      }
    });

    queue.schedule({ sceneId: "scene", label: "old" }, create, save, vi.fn());
    await flushPromises();
    const latestTask = queue.schedule(
      { sceneId: "scene", label: "latest" },
      create,
      save,
      vi.fn(),
    );

    expect(saved).toEqual(["old"]);
    resolveOld?.();
    await latestTask;

    expect(saved).toEqual(["old", "latest"]);
    expect(saved.at(-1)).toBe("latest");
  });

  it("calls save with null when create produces null output (e.g. empty board)", async () => {
    const queue = new LatestThumbnailSaveQueue<TestSnapshot>();
    const create = vi.fn(async () => null);
    const save = vi.fn(async () => undefined);

    await queue.schedule(
      { sceneId: "scene_empty", label: "empty" },
      create,
      save,
      vi.fn(),
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("scene_empty", null);
  });
});
