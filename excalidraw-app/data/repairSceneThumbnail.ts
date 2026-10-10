import { restoreAppState, restoreElements } from "@excalidraw/excalidraw/data/restore";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/element/types";

import { fetchCloudScene, fetchCloudFiles, saveCloudSceneThumbnail } from "./cloudStorage";
import { createSceneThumbnail } from "./sceneThumbnail";

export async function repairSceneThumbnail(
  id: string,
  revision: number,
  isCancelled: () => boolean,
): Promise<string | null> {
  const scene = await fetchCloudScene(id);
  if (isCancelled() || scene.revision !== revision) {
    return null;
  }
  if (scene.thumbnail_file_id) {
    return scene.thumbnail_file_id;
  }
  const elements = restoreElements(scene.elements, null, { repairBindings: true });
  const fileIds = new Set<FileId>();
  for (const element of elements) {
    if (element.type === "image" && element.fileId && !element.isDeleted) {
      fileIds.add(element.fileId);
    }
  }
  const { loadedFiles, erroredFiles } = await fetchCloudFiles([...fileIds]);
  if (isCancelled() || erroredFiles.size) {
    return null;
  }
  const files: BinaryFiles = Object.fromEntries(loadedFiles.map((file) => [file.id, file]));
  const blob = await createSceneThumbnail({
    elements,
    appState: restoreAppState(scene.appState, null),
    files,
  });
  if (isCancelled() || !blob) {
    return null;
  }
  const result = await saveCloudSceneThumbnail(id, blob, undefined, revision);
  return result.thumbnail_file_id;
}
