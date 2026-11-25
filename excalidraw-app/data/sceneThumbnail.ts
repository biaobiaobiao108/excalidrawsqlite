import { exportToBlob, MIME_TYPES } from "@excalidraw/excalidraw";
import { getNonDeletedElements, isTextElement } from "@excalidraw/element";
import { FONT_FAMILY, LXGW_WENKAI_FONT } from "@excalidraw/common";
import { loadEditorFontStyles } from "./editorFontStyles";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

export const createSceneThumbnail = async ({
  elements,
  appState,
  files,
}: {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
}) => {
  const visibleElements = getNonDeletedElements(elements);
  if (!visibleElements.length) {
    return null;
  }
  if (
    visibleElements.some(
      (element) =>
        isTextElement(element) &&
        (element.fontFamily === FONT_FAMILY[LXGW_WENKAI_FONT] ||
          /\p{Script=Han}/u.test(element.text)),
    )
  ) {
    await loadEditorFontStyles();
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
