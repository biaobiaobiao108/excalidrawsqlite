import { describe, expect, it } from "bun:test";

import {
  CloudSaveQueue,
  getCloudSceneLoadSignatures,
  getCloudSceneRecoveryData,
  matchesPersistedCloudSnapshot,
  type CloudSavePersistence,
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

const createPersistence = () => {
  const snapshots = new Map<string, CloudSaveSnapshot>();
  const persistence: CloudSavePersistence = {
    load: async () => [...snapshots.values()],
    save: async (value) => {
      snapshots.set(value.sceneId, value);
    },
    remove: async (sceneId, expectedSnapshot) => {
      if (!expectedSnapshot || matchesPersistedCloudSnapshot(snapshots.get(sceneId), expectedSnapshot)) {
        snapshots.delete(sceneId);
      }
    },
  };
  return { persistence, snapshots };
};

describe("cloud save queue", () => {
  it("flushes an unchanged opened board without issuing a scene write", async () => {
    const { persistence } = createPersistence();
    let writes = 0;
    const queue = new CloudSaveQueue(callbacks, {
      persistence,
      saveFilesToCloud: async () => {},
      saveCloudScene: async (id) => {
        writes++;
        return { success: true, id, updated_at: 1, revision: 2 };
      },
    });
    await queue.ready();
    queue.setRevision("scene", 5);
    expect(await queue.flush("scene")).toBe("idle");
    expect(writes).toBe(0);
    expect(queue.getRevision("scene")).toBe(5);
    expect(queue.hasPending("scene")).toBe(false);
    queue.dispose();
  });

  it("saves edits after StrictMode replays queue setup and cleanup", async () => {
    const { persistence } = createPersistence();
    const names: string[] = [];
    const queue = new CloudSaveQueue(callbacks, {
      persistence,
      saveFilesToCloud: async () => {},
      saveCloudScene: async (id, data) => {
        names.push(data.name!);
        return { success: true, id, updated_at: 1, revision: 2 };
      },
    });
    queue.activate();
    queue.dispose();
    queue.activate();
    await queue.ready();
    queue.enqueue(snapshot("edit after effect replay"));
    expect(await queue.flush("scene")).toBe("saved");
    expect(names).toEqual(["edit after effect replay"]);
    queue.dispose();
    queue.enqueue(snapshot("edit after real unmount"));
    expect(queue.hasPending("scene")).toBe(false);
  });

  it("exposes recovered content and retains its original revision for the next edit", async () => {
    const { persistence, snapshots } = createPersistence();
    snapshots.set("scene", snapshot("offline content"));
    const revisions: Array<number | undefined> = [];
    const names: string[] = [];
    const queue = new CloudSaveQueue(callbacks, {
      persistence,
      saveFilesToCloud: async () => {},
      saveCloudScene: async (id, data) => {
        revisions.push(data.baseRevision);
        names.push(data.name!);
        return { success: true, id, updated_at: 1, revision: 2 };
      },
    });
    await queue.ready();
    const recovered = queue.getPendingSnapshot("scene")!;
    expect(recovered.name).toBe("offline content");
    queue.setRevision("scene", recovered.baseRevision!);
    queue.enqueue({ ...recovered, name: `${recovered.name} + next edit`, baseRevision: undefined });
    await queue.flush("scene");
    expect(names).toEqual(["offline content + next edit"]);
    expect(revisions).toEqual([1]);
    queue.dispose();
  });

  it("keeps recovered canvas elements after saving and editing again", async () => {
    const { persistence, snapshots } = createPersistence();
    const old = { id: "old", version: 1 };
    const offline = { id: "offline", version: 1 };
    let remote: any = {
      id: "scene", name: "board", elements: [old],
      appState: { viewBackgroundColor: "#ffffff", gridSize: 20 }, revision: 1,
    };
    snapshots.set("scene", { ...snapshot("board"), elements: [old, offline] as any });
    const queue = new CloudSaveQueue(callbacks, {
      persistence,
      saveFilesToCloud: async () => {},
      saveCloudScene: async (id, data) => {
        remote = { ...remote, ...data, revision: remote.revision + 1 };
        return { success: true, id, updated_at: 1, revision: remote.revision };
      },
    });
    await queue.ready();
    const recovered = queue.getPendingSnapshot("scene")!;
    const loaded = getCloudSceneRecoveryData(remote, recovered);
    let canvas = loaded.elements;
    queue.setRevision("scene", recovered.baseRevision!);
    await queue.flush("scene");
    expect(canvas.map((element) => element.id)).toEqual(["old", "offline"]);
    canvas = [...canvas, { id: "new", version: 1 }];
    queue.enqueue({ sceneId: "scene", name: loaded.name, elements: canvas as any, appState: recovered.appState, files: {} });
    await queue.flush("scene");
    expect(remote.elements.map((element: any) => element.id)).toEqual(["old", "offline", "new"]);
    queue.dispose();
  });

  for (const disposeOlder of [false, true]) {
    it(`protects another editor's newer snapshot when an older save finishes (disposed=${disposeOlder})`, async () => {
      const { persistence, snapshots } = createPersistence();
      let started!: () => void;
      let release!: () => void;
      const saving = new Promise<void>((resolve) => { started = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const statuses: string[] = [];
      const older = new CloudSaveQueue({ ...callbacks, onStatusChange: (_, status) => { statuses.push(status); } }, {
        persistence,
        saveFilesToCloud: async () => {},
        saveCloudScene: async (id) => {
          started();
          await held;
          return { success: true, id, updated_at: 1, revision: 2 };
        },
      });
      await older.ready();
      older.enqueue(snapshot("older"));
      const flushing = older.flush("scene");
      await saving;
      if (disposeOlder) older.dispose();
      const newer = new CloudSaveQueue(callbacks, { persistence });
      await newer.ready();
      newer.enqueue(snapshot("newer offline edit"));
      await Promise.resolve();
      const statusCount = statuses.length;
      release();
      await flushing;
      expect(snapshots.get("scene")?.name).toBe("newer offline edit");
      expect(newer.hasPending("scene")).toBe(true);
      if (disposeOlder) expect(statuses.length).toBe(statusCount);
      older.dispose();
      newer.dispose();
    });
  }

  it("compares load-time edits with the remote baseline after files load", () => {
    const remoteImage = {
      id: "image",
      type: "image",
      fileId: "file",
      version: 1,
      versionNonce: 11,
      isDeleted: false,
    };
    const remoteScene = {
      name: "remote scene",
      elements: [remoteImage],
      appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
      files: {
        file: {
          id: "file",
          mimeType: "image/png",
          created: 1,
          dataURL: "data:image/png;base64,AA==",
        },
      } as any,
    };

    // Completing asynchronous attachment hydration should not create a
    // difference when the editor still matches the remote scene.
    expect(
      getCloudSceneLoadSignatures(remoteScene, remoteScene).hasChanges,
    ).toBe(false);

    const editedScene = {
      ...remoteScene,
      elements: [{ ...remoteImage, version: 2, versionNonce: 22 }],
    };
    const signatures = getCloudSceneLoadSignatures(
      remoteScene,
      editedScene,
    );

    expect(signatures.hasChanges).toBe(true);
    expect(signatures.baselineSignature).not.toBe(
      signatures.currentSignature,
    );
  });

  it("adopts restore normalization without saving but preserves load-time user edits", () => {
    const remoteScene = {
      name: "MCP board",
      elements: [{
        id: "text", type: "text", text: "label", width: 80,
        version: 1, versionNonce: 11, isDeleted: false,
      }],
      appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
      files: {},
    };
    const hydratedScene = {
      ...remoteScene,
      elements: [{ ...remoteScene.elements[0], width: 85, version: 2, versionNonce: 22 }],
    };
    const hydration = getCloudSceneLoadSignatures(remoteScene, hydratedScene, false);
    expect(hydration.hasChanges).toBe(false);
    expect(hydration.baselineSignature).toBe(hydration.currentSignature);

    const editedScene = {
      ...hydratedScene,
      elements: [{ ...hydratedScene.elements[0], text: "user edit", version: 3, versionNonce: 33 }],
    };
    expect(getCloudSceneLoadSignatures(remoteScene, editedScene, true).hasChanges).toBe(true);
    // A subsequent local edit must also differ from the adopted baseline.
    expect(getCloudSceneLoadSignatures(hydratedScene, editedScene).hasChanges).toBe(true);
  });

  it("keeps the latest edit when an in-flight save requires authentication", async () => {
    const { persistence } = createPersistence();
    const savedNames: string[] = [];
    let signalFirstSave!: () => void;
    let rejectFirstSave!: (reason: Error) => void;
    const firstSaveStarted = new Promise<void>((resolve) => {
      signalFirstSave = resolve;
    });
    const queue = new CloudSaveQueue(callbacks, {
      persistence,
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
    const { persistence } = createPersistence();
    const savedNames: string[] = [];
    let signalFirstSave!: () => void;
    const firstSaveStarted = new Promise<void>((resolve) => {
      signalFirstSave = resolve;
    });
    const queue = new CloudSaveQueue(callbacks, {
      persistence,
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
          persistence: createPersistence().persistence,
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

  it("restores the latest failed snapshot from persistence and retries it", async () => {
    const { persistence, snapshots } = createPersistence();
    const failedQueue = new CloudSaveQueue(callbacks, {
      persistence,
      saveFilesToCloud: async () => {},
      saveCloudScene: async () => {
        throw new Error("network unavailable");
      },
    });

    failedQueue.enqueue(snapshot("recover me"));
    expect(await failedQueue.flush("scene")).toBe("error");
    expect(snapshots.get("scene")?.name).toBe("recover me");

    const recoveredNames: string[] = [];
    const recoveredQueue = new CloudSaveQueue(callbacks, {
      persistence,
      saveFilesToCloud: async () => {},
      saveCloudScene: async (id, data) => {
        recoveredNames.push(data.name || "");
        return { success: true, id, updated_at: Date.now(), revision: 2 };
      },
    });
    await recoveredQueue.ready();
    expect(recoveredQueue.hasPending("scene")).toBe(true);
    expect(await recoveredQueue.flush("scene")).toBe("saved");
    expect(recoveredNames).toEqual(["recover me"]);
    expect(snapshots.size).toBe(0);
  });

  it("recognizes a save that committed before the persisted snapshot was cleared", async () => {
    const { persistence, snapshots } = createPersistence();
    let failFirstRemove = true;
    const flakyPersistence: CloudSavePersistence = {
      ...persistence,
      remove: async (sceneId) => {
        if (failFirstRemove) {
          failFirstRemove = false;
          throw new Error("storage temporarily unavailable");
        }
        await persistence.remove(sceneId);
      },
    };
    const committed = snapshot("already committed");
    const firstQueue = new CloudSaveQueue(callbacks, {
      persistence: flakyPersistence,
      saveFilesToCloud: async () => {},
      saveCloudScene: async (id) => ({
        success: true,
        id,
        updated_at: Date.now(),
        revision: 2,
      }),
    });
    firstQueue.enqueue(committed);
    expect(await firstQueue.flush("scene")).toBe("saved");
    expect(snapshots.has("scene")).toBe(true);

    const recoveredQueue = new CloudSaveQueue(callbacks, {
      persistence: flakyPersistence,
      saveFilesToCloud: async () => {},
      saveCloudScene: async () => {
        throw new CloudApiError("revision conflict", 409, "REVISION_CONFLICT");
      },
      fetchCloudScene: async () => ({
        id: "scene",
        name: committed.name,
        elements: committed.elements,
        appState: committed.appState,
        created_at: 1,
        updated_at: 2,
        revision: 2,
        tags: [],
        favorite: false,
        folder_id: null,
        last_opened_at: null,
        thumbnail_file_id: null,
      }),
    });
    await recoveredQueue.ready();
    expect(await recoveredQueue.flush("scene")).toBe("saved");
    expect(recoveredQueue.hasPending("scene")).toBe(false);
    expect(snapshots.size).toBe(0);
  });

  it("rebases a fast follow-up snapshot onto the revision from the active save", async () => {
    const { persistence } = createPersistence();
    let releaseFirstSave!: () => void;
    let signalFirstSave!: () => void;
    const firstSaveStarted = new Promise<void>((resolve) => {
      signalFirstSave = resolve;
    });
    const baseRevisions: Array<number | undefined> = [];
    let saveCount = 0;
    const queue = new CloudSaveQueue(callbacks, {
      persistence,
      saveFilesToCloud: async () => {},
      saveCloudScene: async (id, data) => {
        baseRevisions.push(data.baseRevision);
        saveCount += 1;
        if (saveCount === 1) {
          signalFirstSave();
          await new Promise<void>((resolve) => {
            releaseFirstSave = resolve;
          });
          return { success: true, id, updated_at: Date.now(), revision: 2 };
        }
        return { success: true, id, updated_at: Date.now(), revision: 3 };
      },
    });
    queue.enqueue(snapshot("first"));
    const flushing = queue.flush("scene");
    await firstSaveStarted;
    queue.enqueue(snapshot("latest"));
    releaseFirstSave();

    expect(await flushing).toBe("saved");
    expect(baseRevisions).toEqual([1, 2]);
    queue.cancel("scene");
  });

  it("coalesces slow persistence writes and flush waits for the latest snapshot", async () => {
    const persistedNames: string[] = [];
    let releaseFirstWrite!: () => void;
    let signalFirstWrite!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      signalFirstWrite = resolve;
    });
    let releaseLatestWrite!: () => void;
    let signalLatestWrite!: () => void;
    const latestWriteStarted = new Promise<void>((resolve) => {
      signalLatestWrite = resolve;
    });
    const persistence: CloudSavePersistence = {
      load: async () => [],
      save: async (value) => {
        persistedNames.push(value.name);
        if (value.name === "first") {
          signalFirstWrite();
          await new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
        }
        if (value.name === "latest") {
          signalLatestWrite();
          await new Promise<void>((resolve) => {
            releaseLatestWrite = resolve;
          });
        }
      },
      remove: async () => {},
    };
    let cloudSaveCount = 0;
    const queue = new CloudSaveQueue(callbacks, {
      persistence,
      saveFilesToCloud: async () => {},
      saveCloudScene: async (id) => {
        cloudSaveCount += 1;
        return { success: true, id, updated_at: Date.now(), revision: 2 };
      },
    });

    queue.enqueue(snapshot("first"));
    await firstWriteStarted;
    queue.enqueue(snapshot("intermediate"));
    queue.enqueue(snapshot("latest"));
    const flushing = queue.flush("scene");
    expect(cloudSaveCount).toBe(0);

    releaseFirstWrite();
    await latestWriteStarted;
    expect(persistedNames).toEqual(["first", "latest"]);
    expect(cloudSaveCount).toBe(0);

    releaseLatestWrite();
    expect(await flushing).toBe("saved");
    expect(cloudSaveCount).toBe(1);
    queue.cancel("scene");
  });
});
