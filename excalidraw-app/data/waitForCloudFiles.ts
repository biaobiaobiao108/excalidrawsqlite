import type { FileId } from "@excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import { FileStatusStore } from "./fileStatusStore";

/** Read hydrated files only after loading finishes, while retaining scene ownership. */
export const waitForCloudFiles = async (
  fileIds: readonly FileId[],
  getFiles: () => BinaryFiles,
  isCurrentScene: () => boolean,
): Promise<BinaryFiles> => {
  const deadline = Date.now() + 30_000;
  while (true) {
    if (!isCurrentScene()) {
      throw new Error("画板已切换，请在当前画板重新保存");
    }
    const statuses = FileStatusStore.getSnapshot().value;
    if (fileIds.some((fileId) => statuses.get(fileId) === "loading")) {
      if (Date.now() >= deadline) {
        throw new Error("图片加载超时，请稍后重试");
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      continue;
    }
    const allFiles = getFiles();
    const files: BinaryFiles = {};
    for (const fileId of fileIds) {
      const file = allFiles[fileId];
      if (statuses.get(fileId) === "error" && !file) {
        throw new Error(`图片 ${fileId} 加载失败，请重新加载后再保存`);
      }
      if (!file?.dataURL) {
        throw new Error(`图片 ${fileId} 尚未准备完成，请稍后重试`);
      }
      files[fileId] = file;
    }
    return files;
  }
};
