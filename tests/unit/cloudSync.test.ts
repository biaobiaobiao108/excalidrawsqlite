import { describe, expect, it } from "bun:test";

import {
  CloudSaveQueue,
  getCloudSnapshotFiles,
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
      snapshots.set(value.persistenceKey || value.sceneId, value);
    },
    remove: async (sceneId, expectedSnapshot, persistenceKey) => {
      const key = expectedSnapshot?.persistenceKey || persistenceKey || sceneId;
      if (!expectedSnapshot || matchesPersistedCloudSnapshot(snapshots.get(key), expectedSnapshot)) {
        snapshots.delete(key);
      }
    },
  };
  return { persistence, snapshots };
};

const snapshotForScene = (snapshots: Map<string, CloudSaveSnapshot>, sceneId: string) =>
  [...snapshots.values()].find((value) => value.sceneId === sceneId);

describe("cloud save queue", () => {
  it("detects changed file payloads through their version without serializing data URLs", () => {
    const image = {
      id: "image",
      type: "image",
      fileId: "file",
      version: 1,
      versionNonce: 11,
      isDeleted: false,
    };
    const original = {
      name: "scene",
      elements: [image],
      appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
      files: {
        file: {
          id: "file",
          mimeType: "image/png",
          created: 1,
          version: 1,
          dataURL: "data:image/png;base64,AAAA",
        },
      } as any,
    };
    const replacedFile = {
      ...original.files.file,
      version: 2,
      dataURL: "data:image/png;base64,BBBB",
    };

    expect(replacedFile.dataURL.length).toBe(original.files.file.dataURL.length);
    expect(
      getCloudSceneLoadSignatures(original, {
        ...original,
        files: { file: replacedFile } as any,
      }).hasChanges,
    ).toBe(true);
  });

  it("serializes concurrent flushes without starving network completions", () => {
    // A regression can spin in microtasks and prevent even the test runner's
    // timeout from firing. Keep the real queue in a bounded child process.
    const queueModule = new URL("../../excalidraw-app/data/cloudSync.ts", import.meta.url).href;
    const result = Bun.spawnSync([process.execPath, "--eval", `
      import { CloudSaveQueue } from ${JSON.stringify(queueModule)};
      globalThis.BroadcastChannel = undefined;
      let releaseFirst;
      let signalFirst;
      const firstStarted = new Promise(resolve => { signalFirst = resolve; });
      const firstReleased = new Promise(resolve => { releaseFirst = resolve; });
      const saved = [];
      let activeWrites = 0;
      let maxActiveWrites = 0;
      const queue = new CloudSaveQueue({
        onAuthRequired() {}, onConflict() {}, onError(error) { throw error; },
      }, {
        persistence: { load: async () => [], save: async () => {}, remove: async () => {} },
        saveFilesToCloud: async () => {},
        saveCloudScene: async (id) => {
          maxActiveWrites = Math.max(maxActiveWrites, ++activeWrites);
          if (id === "A") {
            signalFirst();
            await firstReleased;
          } else {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          activeWrites--;
          saved.push(id);
          return { success: true, id, updated_at: 1, revision: 2 };
        },
      });
      await queue.ready();
      for (const sceneId of ["A", "B", "C"]) {
        queue.enqueue({ sceneId, name: sceneId, elements: [], files: {},
          appState: { viewBackgroundColor: "#ffffff", gridSize: 20 }, baseRevision: 1 });
      }
      const first = queue.flushAll();
      await firstStarted;
      const second = queue.flushAll();
      const third = queue.flushAll();
      releaseFirst();
      await Promise.all([first, second, third]);
      console.log(JSON.stringify({ saved, maxActiveWrites,
        pending: ["A", "B", "C"].some(id => queue.hasPending(id)) }));
      queue.dispose();
    `], { timeout: 5000, stdout: "pipe", stderr: "pipe" });

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
      saved: ["A", "B", "C"],
      maxActiveWrites: 1,
      pending: false,
    });
  }, 10_000);

  it("reports each committed preview snapshot with its own revision during overlapping edits", async () => {
    const { persistence } = createPersistence();
    let started!: () => void;
    let release!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const firstReleased = new Promise<void>((resolve) => { release = resolve; });
    const previews: Array<[string, number]> = [];
    let writes = 0;
    const queue = new CloudSaveQueue({
      ...callbacks,
      onSnapshotSaved: (saved, revision) => { previews.push([saved.name, revision]); },
    }, {
      persistence,
      saveFilesToCloud: async () => {},
      saveCloudScene: async (id) => {
        if (++writes === 1) {
          started();
          await firstReleased;
        }
        return { success: true, id, updated_at: 1, revision: writes + 1 };
      },
    });
    try {
      await queue.ready();
      queue.enqueue(snapshot("first"));
      const saving = queue.flush("scene");
      await firstStarted;
      queue.enqueue(snapshot("latest"));
      expect(previews).toEqual([]);
      release();
      expect(await saving).toBe("saved");
      expect(previews).toEqual([["first", 2], ["latest", 3]]);
    } finally {
      release();
      queue.dispose();
    }
  });

  it("does not generate previews for rejected content writes", async () => {
    const { persistence } = createPersistence();
    let previews = 0;
    const queue = new CloudSaveQueue({
      ...callbacks, onSnapshotSaved: () => { previews++; },
    }, {
      persistence,
      saveFilesToCloud: async () => {},
      saveCloudScene: async () => { throw new CloudApiError("auth", 401, "AUTH_REQUIRED"); },
    });
    try {
      await queue.ready();
      queue.enqueue(snapshot("unsaved"));
      expect(await queue.flush("scene")).toBe("auth");
      expect(previews).toBe(0);
    } finally {
      queue.dispose();
    }
  });

  it("reuploads a cached attachment after server GC rejects its scene reference", async () => {
    const originalFetch = globalThis.fetch;
    const { persistence } = createPersistence();
    const file = {
      id: "queue-gc-recovery", mimeType: "image/png", created: 1,
      dataURL: "data:image/png;base64,aGVsbG8=",
    };
    let attachmentExists = false;
    let uploads = 0;
    let sceneWrites = 0;
    let revision = 1;
    const queue = new CloudSaveQueue(callbacks, {
      persistence,
      saveCloudScene: async (id, data) => {
        sceneWrites++;
        if (!attachmentExists) {
          throw new CloudApiError("attachment reclaimed", 422, "MISSING_FILE");
        }
        expect(data.baseRevision).toBe(revision);
        return { success: true, id, updated_at: 1, revision: ++revision };
      },
    });
    try {
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode("hello"),
      ))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
      globalThis.fetch = (async (input, init) => {
        expect(input).toBe(`/api/files/${file.id}`);
        expect(init?.method).toBe("PUT");
        uploads++;
        attachmentExists = true;
        return new Response(null, { status: 204, headers: { etag: `"${digest}"` } });
      }) as typeof fetch;
      await queue.ready();
      const saved = {
        ...snapshot("with image"),
        elements: [{ id: "image", type: "image", fileId: file.id, version: 1 }],
        files: { [file.id]: file },
      } as unknown as CloudSaveSnapshot;
      queue.enqueue(saved);
      expect(await queue.flush("scene")).toBe("saved");
      expect(uploads).toBe(1);
      // GC removes the remote attachment, while undo retains the local file.
      attachmentExists = false;
      queue.enqueue({ ...saved, baseRevision: revision });
      expect(await queue.flush("scene")).toBe("saved");
      expect(uploads).toBe(2);
      expect(sceneWrites).toBe(3);
      expect(queue.hasPending("scene")).toBe(false);
      queue.enqueue({ ...saved, baseRevision: revision });
      expect(await queue.flush("scene")).toBe("saved");
      expect(uploads).toBe(2);
    } finally {
      queue.dispose();
      globalThis.fetch = originalFetch;
    }
  });

  it("bounds repeated missing attachment recovery and retains the latest edit", async () => {
    const { persistence } = createPersistence();
    const uploads: Array<boolean | undefined> = [];
    let writes = 0;
    const queue = new CloudSaveQueue(callbacks, {
      persistence,
      saveFilesToCloud: async (_, options) => { uploads.push(options?.forceUpload); },
      saveCloudScene: async () => {
        if (++writes === 1) queue.enqueue(snapshot("newer"));
        throw new CloudApiError("attachment missing", 422, "MISSING_FILE");
      },
    });
    try {
      await queue.ready();
      queue.enqueue(snapshot("older"));
      expect(await queue.flush("scene")).toBe("error");
      expect(writes).toBe(3);
      expect(uploads).toEqual([undefined, true, true]);
      expect(queue.getPendingSnapshot("scene")?.name).toBe("newer");
    } finally {
      queue.dispose();
    }
  });

  for (const status of [401, 409]) {
    it(`preserves ${status} handling after a forced attachment reupload`, async () => {
      const { persistence } = createPersistence();
      let writes = 0;
      let auth = 0;
      let conflicts = 0;
      const queue = new CloudSaveQueue({
        ...callbacks,
        onAuthRequired: () => { auth++; },
        onConflict: () => { conflicts++; },
      }, {
        persistence,
        saveFilesToCloud: async () => {},
        saveCloudScene: async () => {
          if (++writes === 1) throw new CloudApiError("missing", 422, "MISSING_FILE");
          throw new CloudApiError("blocked", status, "BLOCKED");
        },
        fetchCloudScene: async () => {
          throw new Error("remote unavailable");
        },
      });
      try {
        await queue.ready();
        queue.enqueue(snapshot("recover"));
        expect(await queue.flush("scene")).toBe(status === 401 ? "auth" : "conflict");
        expect(writes).toBe(2);
        expect(auth).toBe(status === 401 ? 1 : 0);
        expect(conflicts).toBe(status === 409 ? 1 : 0);
        expect(queue.hasPending("scene")).toBe(true);
      } finally {
        queue.dispose();
      }
    });
  }

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
      expect(snapshotForScene(snapshots, "scene")?.name).toBe("newer offline edit");
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

  it("retries after the sign-in prompt is dismissed instead of staying blocked", async () => {
    const { persistence } = createPersistence();
    const statuses: string[] = [];
    const queue = new CloudSaveQueue(
      {
        ...callbacks,
        onStatusChange: (_sceneId, status) => statuses.push(status),
      },
      {
        persistence,
        saveFilesToCloud: async () => {},
        saveCloudScene: async () => {
          throw new CloudApiError("session expired", 401, "AUTH_REQUIRED");
        },
      },
    );

    queue.enqueue(snapshot("draft"));
    expect(await queue.flush("scene")).toBe("auth");

    // Editing while the prompt is open must not claim the save is queued.
    statuses.length = 0;
    queue.enqueue(snapshot("draft again"));
    expect(statuses).toEqual([]);
    expect(queue.getStatus("scene")).toBe("auth");

    queue.releaseAuthBlock("scene");
    expect(queue.getStatus("scene")).toBe("error");
    // The recovered snapshot is still queued and can be retried.
    expect(queue.hasPending("scene")).toBe(true);
    expect(await queue.flush("scene")).toBe("auth");
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
    expect(snapshotForScene(snapshots, "scene")?.name).toBe("recover me");

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

  it("recovers an IndexedDB write failure from the session snapshot", async () => {
    const values = new Map<string, string>();
    const storage = {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] || null,
      getItem: (key: string) => values.get(key) || null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    } as Storage;
    values.set("excalidraw_cloud_save_recovery_v1:scene", "{malformed");
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { sessionStorage: storage },
    });

    try {
      const { persistence } = createPersistence();
      const failingPersistence: CloudSavePersistence = {
        ...persistence,
        save: async () => {
          throw new Error("IndexedDB quota exceeded");
        },
      };
      const original = snapshot("restore after local storage failure");
      const queue = new CloudSaveQueue(callbacks, {
        persistence: failingPersistence,
        saveFilesToCloud: async () => {},
        saveCloudScene: async () => {
          throw new CloudApiError("authentication required", 401, "AUTH_REQUIRED");
        },
      });
      await queue.ready();
      queue.enqueue(original);
      expect(await queue.flush("scene")).toBe("auth");
      expect(queue.getPendingSnapshot("scene")?.name).toBe(original.name);
      expect(values.size).toBe(1);

      const recoveredQueue = new CloudSaveQueue(callbacks, {
        persistence: {
          load: async () => [],
          save: async () => {},
          remove: async () => {},
        },
        saveFilesToCloud: async () => {},
        saveCloudScene: async (id) => ({
          success: true,
          id,
          updated_at: Date.now(),
          revision: 2,
        }),
      });
      await recoveredQueue.ready();
      expect(recoveredQueue.getPendingSnapshot("scene")?.name).toBe(original.name);
      expect(await recoveredQueue.flush("scene")).toBe("saved");
      expect(values.size).toBe(0);
    } finally {
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("retains the active snapshot in memory when the editor is disposed", async () => {
    let releaseSave!: () => void;
    let signalSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      signalSaveStarted = resolve;
    });
    const queue = new CloudSaveQueue(callbacks, {
      persistence: createPersistence().persistence,
      saveFilesToCloud: async () => {},
      saveCloudScene: async (id) => {
        signalSaveStarted();
        await new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
        return { success: true, id, updated_at: Date.now(), revision: 2 };
      },
    });

    queue.enqueue(snapshot("retain during unmount"));
    const flush = queue.flush("scene");
    await saveStarted;
    queue.dispose();

    expect(queue.hasPending("scene")).toBe(true);
    releaseSave();
    await flush;
    expect(queue.getPendingSnapshot("scene")?.name).toBe(
      "retain during unmount",
    );
  });

  it("recognizes a save that committed before the persisted snapshot was cleared", async () => {
    const { persistence, snapshots } = createPersistence();
    let failFirstRemove = true;
    const flakyPersistence: CloudSavePersistence = {
      ...persistence,
      remove: async (sceneId, expectedSnapshot, persistenceKey) => {
        if (failFirstRemove) {
          failFirstRemove = false;
          throw new Error("storage temporarily unavailable");
        }
        await persistence.remove(sceneId, expectedSnapshot, persistenceKey);
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
    expect(snapshotForScene(snapshots, "scene")).toBeDefined();

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

  it("keeps unsaved snapshots from two tabs for the same scene independently", async () => {
    const { persistence, snapshots } = createPersistence();
    const failingSave = async () => {
      throw new Error("offline");
    };
    const tabA = new CloudSaveQueue(callbacks, {
      persistence,
      saveFilesToCloud: async () => {},
      saveCloudScene: failingSave,
    });
    const tabB = new CloudSaveQueue(callbacks, {
      persistence,
      saveFilesToCloud: async () => {},
      saveCloudScene: failingSave,
    });
    try {
      tabA.enqueue({ ...snapshot("branch A"), persistenceKey: "tab-A:scene" });
      tabB.enqueue({ ...snapshot("branch B"), persistenceKey: "tab-B:scene" });
      await Promise.all([tabA.flush("scene"), tabB.flush("scene")]);

      expect(snapshots.size).toBe(2);
      expect(snapshots.get("tab-A:scene")?.name).toBe("branch A");
      expect(snapshots.get("tab-B:scene")?.name).toBe("branch B");
    } finally {
      tabA.dispose();
      tabB.dispose();
    }
  });

  it("rebuilds the snapshot file map from files available after image loading", () => {
    const ids = ["image-a", "image-b"] as any;
    const initialFiles = { "image-a": { id: "image-a" } } as any;
    const hydratedFiles = {
      ...initialFiles,
      "image-b": { id: "image-b", dataURL: "data:image/png;base64,aA==" },
    } as any;

    expect(getCloudSnapshotFiles(ids, initialFiles)).toEqual(initialFiles);
    expect(getCloudSnapshotFiles(ids, hydratedFiles)).toEqual(hydratedFiles);
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
