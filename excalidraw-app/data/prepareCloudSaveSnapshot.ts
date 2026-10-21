import type { FileId } from "@excalidraw/element/types";
import type { CloudSaveSnapshot } from "./cloudSync";

import { waitForCloudFiles } from "./waitForCloudFiles";

/** Capture the current edit when its attachments are ready, before enqueueing. */
export const prepareCloudSaveSnapshot = async (
  getSnapshot: () => CloudSaveSnapshot | null,
  isCurrentScene: () => boolean,
): Promise<CloudSaveSnapshot> => {
  let snapshot: CloudSaveSnapshot | null = null;
  const files = await waitForCloudFiles(
    () => {
      const current = getSnapshot();
      if (!current) {
        throw new Error("画板已切换，请在当前画板重新保存");
      }
      const elements = current.elements.filter((element) => !element.isDeleted);
      snapshot = { ...current, elements };
      return [...new Set(elements.flatMap((element) =>
        element.type === "image" && element.fileId ? [element.fileId as FileId] : [],
      ))];
    },
    () => snapshot!.files,
    isCurrentScene,
  );
  return { ...snapshot!, files };
};
