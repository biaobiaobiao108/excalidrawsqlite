import {
  exportToBlob,
  MIME_TYPES,
} from "@excalidraw/excalidraw";
import { getNonDeletedElements } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";

export const createSceneThumbnail = async ({
  elements,
  appState,
  files,
}: {
  elements: readonly ExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
}) => {
  const visibleElements = getNonDeletedElements(elements);
  if (!visibleElements.length) {
    return null;
  }

  return exportToBlob({
    elements: visibleElements,
    appState: {
      ...appState,
      exportBackground: true,
      viewBackgroundColor: appState.viewBackgroundColor,
      exportWithDarkMode: false,
    },
    files,
    mimeType: MIME_TYPES.jpg,
    quality: 0.82,
    maxWidthOrHeight: 640,
    exportPadding: 32,
  });
};
