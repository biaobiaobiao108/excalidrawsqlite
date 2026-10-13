import { describe, expect, it } from "bun:test";

import type { FileId } from "@excalidraw/element/types";
import type { BinaryFiles, DataURL } from "@excalidraw/excalidraw/types";

import { FileStatusStore } from "../../excalidraw-app/data/fileStatusStore";
import { waitForCloudFiles } from "../../excalidraw-app/data/waitForCloudFiles";

describe("cloud save attachment hydration", () => {
  it("reads the replacement file collection after a pending download finishes", async () => {
    const fileId = "save-hydration" as FileId;
    let files: BinaryFiles = {};
    const token = FileStatusStore.beginLoading([fileId]);
    const waiting = waitForCloudFiles([fileId], () => files, () => true);
    const file = {
      id: fileId, mimeType: "image/png" as const, created: 1,
      dataURL: "data:image/png;base64,aGVsbG8=" as DataURL,
    };
    files = { [fileId]: file };
    FileStatusStore.finishLoading(token, [[fileId, "loaded"]]);
    expect(await waiting).toEqual({ [fileId]: file });
  });

  it("rejects a save if the scene changes while attachments load", async () => {
    const fileId = "save-scene-switch" as FileId;
    let isCurrent = true;
    const token = FileStatusStore.beginLoading([fileId]);
    const waiting = waitForCloudFiles([fileId], () => ({}), () => isCurrent);
    isCurrent = false;
    FileStatusStore.cancelLoading(token);
    await expect(waiting).rejects.toThrow("画板已切换");
  });

  it("keeps missing and failed attachments from being silently saved", async () => {
    const fileId = "save-missing" as FileId;
    await expect(waitForCloudFiles([fileId], () => ({}), () => true))
      .rejects.toThrow("尚未准备完成");
    FileStatusStore.updateStatuses([[fileId, "error"]]);
    await expect(waitForCloudFiles([fileId], () => ({}), () => true))
      .rejects.toThrow("加载失败");
  });
});
