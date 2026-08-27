import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

import { CloudApiError } from "../data/cloudStorage";
import { CloudSaveQueue, type CloudSaveSnapshot } from "../data/cloudSync";

const makeSnapshot = (name: string): CloudSaveSnapshot => ({
  sceneId: "scene-1",
  name,
  elements: [] as OrderedExcalidrawElement[],
  appState: { viewBackgroundColor: "#fff", gridSize: 0 },
  files: {},
});

describe("cloud save queue", () => {
  const saveCloudScene =
    vi.fn<typeof import("../data/cloudStorage").saveCloudScene>();
  const saveFilesToCloud =
    vi.fn<typeof import("../data/cloudStorage").saveFilesToCloud>();

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
    await vi.advanceTimersByTimeAsync(30_000);
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
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onAuthRequired).toHaveBeenCalledWith("scene-1");

    queue.resumeAfterAuth("scene-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(saveCloudScene).toHaveBeenCalledTimes(2);
    queue.dispose();
  });

  it("does not submit a deleted scene after an attachment upload finishes", async () => {
    let releaseUpload!: () => void;
    saveFilesToCloud.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseUpload = resolve;
        }),
    );
    const queue = new CloudSaveQueue(
      {
        onAuthRequired: vi.fn(),
        onConflict: vi.fn(),
        onError: vi.fn(),
      },
      { saveCloudScene, saveFilesToCloud },
    );

    queue.enqueue(makeSnapshot("to-delete"));
    await vi.advanceTimersByTimeAsync(30_000);
    queue.cancel("scene-1");
    releaseUpload();
    await vi.runAllTimersAsync();

    expect(saveCloudScene).not.toHaveBeenCalled();
    queue.dispose();
  });

  it("uses the newest local snapshot when resolving a conflict", async () => {
    saveCloudScene
      .mockRejectedValueOnce(
        new CloudApiError("版本冲突", 409, "REVISION_CONFLICT"),
      )
      .mockResolvedValueOnce({
        success: true,
        id: "scene-1",
        updated_at: 3,
        revision: 3,
      });
    const queue = new CloudSaveQueue(
      {
        onAuthRequired: vi.fn(),
        onConflict: vi.fn(),
        onError: vi.fn(),
      },
      { saveCloudScene, saveFilesToCloud },
    );

    queue.enqueue(makeSnapshot("conflicted"));
    await vi.advanceTimersByTimeAsync(30_000);
    queue.enqueue(makeSnapshot("newest"));
    queue.resolveConflict("scene-1", 2, true);
    await vi.advanceTimersByTimeAsync(0);

    expect(saveCloudScene).toHaveBeenLastCalledWith(
      "scene-1",
      expect.objectContaining({ name: "newest", baseRevision: 2 }),
    );
    queue.dispose();
  });

  it("keeps a pending snapshot's base revision stable when another tab saves", async () => {
    const queue = new CloudSaveQueue(
      {
        onAuthRequired: vi.fn(),
        onConflict: vi.fn(),
        onError: vi.fn(),
      },
      { saveCloudScene, saveFilesToCloud },
    );
    queue.setRevision("scene-1", 1);
    queue.enqueue(makeSnapshot("local"));
    queue.setRevision("scene-1", 2);

    await queue.flush("scene-1");

    expect(saveCloudScene).toHaveBeenCalledWith(
      "scene-1",
      expect.objectContaining({ name: "local", baseRevision: 1 }),
    );
    queue.dispose();
  });

  it("accurately reports pending state via hasPending", () => {
    const queue = new CloudSaveQueue(
      {
        onAuthRequired: vi.fn(),
        onConflict: vi.fn(),
        onError: vi.fn(),
      },
      { saveCloudScene, saveFilesToCloud },
    );

    expect(queue.hasPending("scene-1")).toBe(false);
    queue.enqueue(makeSnapshot("pending-test"));
    expect(queue.hasPending("scene-1")).toBe(true);
    queue.cancel("scene-1");
    expect(queue.hasPending("scene-1")).toBe(false);
    queue.dispose();
  });

  it("flushes a pending snapshot immediately and reports its final status", async () => {
    const statuses: string[] = [];
    const queue = new CloudSaveQueue(
      {
        onAuthRequired: vi.fn(),
        onConflict: vi.fn(),
        onError: vi.fn(),
        onStatusChange: (_sceneId, status) => statuses.push(status),
      },
      { saveCloudScene, saveFilesToCloud },
    );

    queue.enqueue(makeSnapshot("flush-now"));
    await queue.flush("scene-1");

    expect(saveFilesToCloud).toHaveBeenCalledTimes(1);
    expect(saveCloudScene).toHaveBeenCalledTimes(1);
    expect(queue.hasPending("scene-1")).toBe(false);
    expect(statuses).toEqual(["pending", "saving", "saved"]);
    queue.dispose();
  });

  it("does not autosave before the 30 second handoff safety window", async () => {
    const queue = new CloudSaveQueue(
      {
        onAuthRequired: vi.fn(),
        onConflict: vi.fn(),
        onError: vi.fn(),
      },
      { saveCloudScene, saveFilesToCloud },
    );

    queue.enqueue(makeSnapshot("delayed"));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(saveCloudScene).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(saveCloudScene).toHaveBeenCalledOnce();
    queue.dispose();
  });

  it("keeps a failed snapshot for an explicit retry", async () => {
    const onError = vi.fn();
    saveCloudScene
      .mockRejectedValueOnce(new Error("网络暂时不可用"))
      .mockRejectedValueOnce(new Error("网络暂时不可用"))
      .mockRejectedValueOnce(new Error("网络暂时不可用"))
      .mockResolvedValueOnce({
        success: true,
        id: "scene-1",
        updated_at: 2,
        revision: 2,
      });
    const queue = new CloudSaveQueue(
      {
        onAuthRequired: vi.fn(),
        onConflict: vi.fn(),
        onError,
      },
      { saveCloudScene, saveFilesToCloud },
    );

    queue.enqueue(makeSnapshot("retry"));
    const firstFlush = queue.flush("scene-1");
    await vi.runAllTimersAsync();
    await firstFlush;
    expect(onError).toHaveBeenCalledOnce();
    expect(queue.hasPending("scene-1")).toBe(true);

    await queue.flush("scene-1");
    expect(saveCloudScene).toHaveBeenCalledTimes(4);
    expect(queue.hasPending("scene-1")).toBe(false);
    queue.dispose();
  });
});
