import { describe, expect, it, vi } from "vitest";

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
    const save = vi.fn(async (_sceneId: string, output: string) => {
      saved.push(output);
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
});
