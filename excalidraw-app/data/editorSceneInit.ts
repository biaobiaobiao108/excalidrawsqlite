import {
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import type { RestoredDataState } from "@excalidraw/excalidraw/data/restore";
import type { FileId } from "@excalidraw/element/types";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";

import { fetchCloudScene, type CloudSceneData } from "./cloudStorage";
import { importFromLocalStorage } from "./localStorage";
import { LocalData } from "./LocalData";

/**
 * Cloud scenes still mirror their attachments into IndexedDB (undo and offline
 * recovery rely on it), but the local-mode cleanup pass is skipped for them.
 * Reclaim anything the loaded scene does not reference; `clearObsoleteFiles`
 * only removes entries unused for more than a day, so boards the user just
 * switched away from keep their cached files.
 */
export const clearObsoleteLocalFiles = (currentFileIds: FileId[]) => {
  void LocalData.fileStorage
    .clearObsoleteFiles({ currentFileIds })
    .catch(() => {});
};

export type InitializeSceneResult = {
  scene: ExcalidrawInitialDataState | null;
  cloudScene?: CloudSceneData;
};

export const restoreCloudScene = (
  cloudScene: CloudSceneData,
): ExcalidrawInitialDataState => ({
  elements: restoreElements(cloudScene.elements, null, {
    repairBindings: true,
    deleteInvisibleElements: true,
  }),
  appState: restoreAppState(
    { ...cloudScene.appState, name: cloudScene.name },
    null,
  ),
});

export const initializeScene = async (
  prefetchedCloudScene?: CloudSceneData | null,
): Promise<InitializeSceneResult> => {
  const searchParams = new URLSearchParams(window.location.search);
  const id = searchParams.get("id");

  if (id) {
    const cloudScene =
      prefetchedCloudScene?.id === id
        ? prefetchedCloudScene
        : await fetchCloudScene(id);
    return {
      scene: restoreCloudScene(cloudScene),
      cloudScene,
    };
  }

  const localDataState = importFromLocalStorage();

  const scene: Omit<
    RestoredDataState,
    // we're not storing files in the scene database/localStorage, and instead
    // fetch them async from a different store
    "files"
  > & {
    scrollToContent?: boolean;
  } = {
    elements: restoreElements(localDataState?.elements, null, {
      repairBindings: true,
      deleteInvisibleElements: true,
    }),
    appState: restoreAppState(localDataState?.appState, null),
  };

  return { scene };
};

export const getCloudFileIds = (elements: readonly any[]) => {
  const fileIds = new Set<FileId>();
  for (const element of elements) {
    if (
      element?.type === "image" &&
      element.isDeleted !== true &&
      typeof element.fileId === "string"
    ) {
      fileIds.add(element.fileId);
    }
  }
  return [...fileIds];
};
