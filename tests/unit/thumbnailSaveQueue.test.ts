import { describe, expect, it } from "bun:test";

import { LatestThumbnailSaveQueue } from "../../excalidraw-app/data/thumbnailSaveQueue";

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe("latest thumbnail save queue", () => {
  it("keeps one latest pending snapshot and lets an active upload finish", async () => {
    const queue = new LatestThumbnailSaveQueue<{ sceneId: string; name: string }>();
    const uploadStarted = deferred<void>();
    const finishUpload = deferred<void>();
    const created: string[] = [];
    const saved: string[] = [];

    const first = queue.schedule(
      { sceneId: "scene", name: "in-flight" },
      async (snapshot) => snapshot.name,
      async (_sceneId, output) => {
        saved.push(output || "");
        uploadStarted.resolve();
        await finishUpload.promise;
      },
      () => {},
    );
    await uploadStarted.promise;

    const superseded = queue.schedule(
      { sceneId: "scene", name: "superseded" },
      async (snapshot) => {
        created.push(snapshot.name);
        return snapshot.name;
      },
      async (_sceneId, output) => {
        saved.push(output || "");
      },
      () => {},
    );
    const latest = queue.schedule(
      { sceneId: "scene", name: "latest" },
      async (snapshot) => {
        created.push(snapshot.name);
        return snapshot.name;
      },
      async (_sceneId, output) => {
        saved.push(output || "");
      },
      () => {},
    );

    // Replacing the pending task releases its promise and captured snapshot.
    await superseded;
    expect(created).toEqual([]);

    finishUpload.resolve();
    await Promise.all([first, latest, queue.flush()]);

    expect(created).toEqual(["latest"]);
    expect(saved).toEqual(["in-flight", "latest"]);
  });

  it("drops a pending snapshot when cancelled", async () => {
    const queue = new LatestThumbnailSaveQueue<{ sceneId: string; name: string }>();
    const createStarted = deferred<void>();
    const finishCreate = deferred<string>();
    const created: string[] = [];
    const first = queue.schedule(
      { sceneId: "scene", name: "rendering" },
      async () => {
        createStarted.resolve();
        return finishCreate.promise;
      },
      async () => {},
      () => {},
    );
    await createStarted.promise;
    const pending = queue.schedule(
      { sceneId: "scene", name: "pending" },
      async (snapshot) => {
        created.push(snapshot.name);
        return snapshot.name;
      },
      async () => {},
      () => {},
    );

    queue.cancel();
    await pending;
    finishCreate.resolve("rendered");
    await Promise.all([first, queue.flush()]);

    expect(created).toEqual([]);
  });
});
