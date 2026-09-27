import { describe, expect, it } from "bun:test";

import type { FileId } from "../../packages/element/src/types";
import { FileStatusStore } from "../../excalidraw-app/data/fileStatusStore";

let nextFileId = 0;
const fileId = () => `file-status-test-${nextFileId++}` as FileId;

describe("file status load ownership", () => {
  it("removes loading state when a stale load is cancelled", () => {
    const id = fileId();
    const load = FileStatusStore.beginLoading([id]);

    expect(FileStatusStore.getSnapshot().value.get(id)).toBe("loading");
    FileStatusStore.cancelLoading(load);
    expect(FileStatusStore.getSnapshot().value.has(id)).toBe(false);
  });

  it("does not let an older load clear a newer load for the same file", () => {
    const id = fileId();
    const olderLoad = FileStatusStore.beginLoading([id]);
    const newerLoad = FileStatusStore.beginLoading([id]);

    FileStatusStore.cancelLoading(olderLoad);
    expect(FileStatusStore.getSnapshot().value.get(id)).toBe("loading");

    FileStatusStore.cancelLoading(newerLoad);
    expect(FileStatusStore.getSnapshot().value.has(id)).toBe(false);
  });

  it("does not let an older load overwrite a newer result", () => {
    const id = fileId();
    const olderLoad = FileStatusStore.beginLoading([id]);
    const newerLoad = FileStatusStore.beginLoading([id]);

    FileStatusStore.finishLoading(olderLoad, [[id, "error"]]);
    expect(FileStatusStore.getSnapshot().value.get(id)).toBe("loading");

    FileStatusStore.finishLoading(newerLoad, [[id, "loaded"]]);
    expect(FileStatusStore.getSnapshot().value.get(id)).toBe("loaded");
  });

  it("restores the prior loaded status when a stale refresh is cancelled", () => {
    const id = fileId();
    FileStatusStore.updateStatuses([[id, "loaded"]]);
    const load = FileStatusStore.beginLoading([id]);

    FileStatusStore.cancelLoading(load);

    expect(FileStatusStore.getSnapshot().value.get(id)).toBe("loaded");
  });
});
