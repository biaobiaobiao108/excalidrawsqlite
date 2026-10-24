import { describe, expect, it } from "bun:test";
import { createCloudSceneRefreshGuard } from "../../excalidraw-app/data/cloudSceneRefresh";

describe("cloud scene refresh ownership", () => {
  it("preserves an edit made while the remote request is in flight, even after it saves", async () => {
    let state = { sceneId: "a", signature: "original", hasPending: false };
    const canApply = createCloudSceneRefreshGuard(() => state);
    let finishFetch!: () => void;
    const fetch = new Promise<void>((resolve) => {
      finishFetch = resolve;
    });
    let canvas = "original";
    let revision = 1;
    const refresh = (async () => {
      await fetch;
      if (canApply()) {
        canvas = "remote";
        revision = 2;
      }
    })();

    canvas = "local edit";
    state = { ...state, signature: canvas, hasPending: true };
    expect(canApply()).toBe(false);
    // A pending-only check would miss this completed save.
    state = { ...state, hasPending: false };
    revision = 3;
    finishFetch();
    await refresh;
    expect(canvas).toBe("local edit");
    expect(revision).toBe(3);
  });

  it("rejects pending snapshots and a change of active board", () => {
    let state = { sceneId: "a", signature: "same", hasPending: true };
    const pendingGuard = createCloudSceneRefreshGuard(() => state);
    state = { ...state, hasPending: false };
    expect(pendingGuard()).toBe(false);
    const guard = createCloudSceneRefreshGuard(() => state);
    state = { ...state, sceneId: "b" };
    expect(guard()).toBe(false);
  });

  it("applies remote content when the active board has stayed unchanged", () => {
    const state = { sceneId: "a", signature: "unchanged", hasPending: false };
    expect(createCloudSceneRefreshGuard(() => state)()).toBe(true);
  });
});
