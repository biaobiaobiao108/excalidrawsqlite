import { describe, expect, it } from "bun:test";

import type { FileId } from "@excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import {
  CloudSaveQueue,
  type CloudSaveSnapshot,
} from "../../excalidraw-app/data/cloudSync";
import { FileStatusStore } from "../../excalidraw-app/data/fileStatusStore";
import { prepareCloudSaveSnapshot } from "../../excalidraw-app/data/prepareCloudSaveSnapshot";

const image = (id: string) =>
  ({
    id,
    type: "image",
    fileId: id,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
  }) as unknown as CloudSaveSnapshot["elements"][number];
const file = (id: FileId): BinaryFileData => ({
  id,
  mimeType: "image/png",
  created: 1,
  dataURL: "data:image/png;base64,aGVsbG8=" as BinaryFileData["dataURL"],
});
const scene = (id: string): CloudSaveSnapshot => ({
  sceneId: "scene",
  name: "original",
  elements: [image(id)],
  appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
  files: {},
});

describe("explicit cloud save snapshot", () => {
  it("preserves newer queued edits made while the explicit save waits for an image", async () => {
    const fileId = "explicit-save-image" as FileId;
    let current = scene(fileId);
    const token = FileStatusStore.beginLoading([fileId]);
    let remote: CloudSaveSnapshot | null = null;
    const queue = new CloudSaveQueue(
      {
        onAuthRequired() {},
        onConflict() {},
        onError(error) {
          throw error;
        },
      },
      {
        persistence: {
          load: async () => [],
          save: async () => {},
          remove: async () => {},
        },
        saveFilesToCloud: async () => {},
        saveCloudScene: async (id, data) => {
          remote = { ...data, sceneId: id } as CloudSaveSnapshot;
          return { success: true, id, revision: 2, updated_at: 1 };
        },
      },
    );
    try {
      await queue.ready();
      queue.setRevision("scene", 1);
      const waiting = prepareCloudSaveSnapshot(
        () => current,
        () => true,
      );
      current = {
        ...current,
        name: "edited while loading",
        elements: [
          ...current.elements,
          { ...image("new-edit"), type: "rectangle" } as any,
        ],
        appState: { ...current.appState, viewBackgroundColor: "#ff0000" },
        files: { [fileId]: file(fileId) },
      };
      queue.enqueue(current);
      FileStatusStore.finishLoading(token, [[fileId, "loaded"]]);
      const prepared = await waiting;
      queue.enqueue(prepared);
      expect(await queue.flush("scene")).toBe("saved");
      expect(remote!.elements.map((element) => element.id)).toEqual([
        fileId,
        "new-edit",
      ]);
      expect(remote!.name).toBe(current.name);
      expect(remote!.appState).toEqual(current.appState);
      expect(queue.hasPending("scene")).toBe(false);
    } finally {
      FileStatusStore.cancelLoading(token);
      queue.dispose();
    }
  });

  it("also waits for images added during hydration and excludes deleted images", async () => {
    const first = "explicit-save-first" as FileId;
    const second = "explicit-save-second" as FileId;
    let current = scene(first);
    const firstToken = FileStatusStore.beginLoading([first]);
    const secondToken = FileStatusStore.beginLoading([second]);
    let sawSecondPoll!: () => void;
    const polled = new Promise<void>((resolve) => {
      sawSecondPoll = resolve;
    });
    let ready = false;
    const waiting = prepareCloudSaveSnapshot(
      () => {
        if (current.files[first]) sawSecondPoll();
        return current;
      },
      () => true,
    ).then((value) => {
      ready = true;
      return value;
    });
    try {
      current = {
        ...current,
        elements: [image(first), image(second)],
        files: { [first]: file(first) },
      };
      FileStatusStore.finishLoading(firstToken, [[first, "loaded"]]);
      await polled;
      expect(ready).toBe(false);
      current = {
        ...current,
        elements: [{ ...image(first), isDeleted: true }, image(second)],
        files: { ...current.files, [second]: file(second) },
      };
      FileStatusStore.finishLoading(secondToken, [[second, "loaded"]]);
      const prepared = await waiting;
      expect(prepared.elements.map((element) => element.id)).toEqual([second]);
      expect(Object.keys(prepared.files)).toEqual([second]);
    } finally {
      FileStatusStore.cancelLoading(firstToken);
      FileStatusStore.cancelLoading(secondToken);
    }
  });

  it("rejects ownership changes instead of saving a different board", async () => {
    const fileId = "explicit-save-switch" as FileId;
    let current = scene(fileId);
    const token = FileStatusStore.beginLoading([fileId]);
    const waiting = prepareCloudSaveSnapshot(
      () => current,
      () => current.sceneId === "scene",
    );
    current = { ...current, sceneId: "different" };
    FileStatusStore.cancelLoading(token);
    await expect(waiting).rejects.toThrow("画板已切换");
  });
});
