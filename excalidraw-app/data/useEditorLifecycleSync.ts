import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { EVENT, debounce, isTestEnv, preventUnload } from "@excalidraw/common";
import { isInitializedImageElement } from "@excalidraw/element";
import { useCallback, useEffect, type MutableRefObject } from "react";

import type { FileId } from "@excalidraw/element/types";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";

import { STORAGE_KEYS, SYNC_BROWSER_TABS_TIMEOUT } from "../app_constants";
import { getPreferredLanguage } from "../app-language/language-detector";
import { updateStaleImageStatuses } from "./FileManager";
import { FileStatusStore } from "./fileStatusStore";
import { importFromLocalStorage } from "./localStorage";
import { LibraryIndexedDBAdapter, LocalData } from "./LocalData";
import { isBrowserStorageStateNewer } from "./tabSync";
import type { CloudSaveQueue } from "./cloudSync";

type UseEditorLifecycleSyncOptions = {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  currentSceneIdRef: MutableRefObject<string | null>;
  cloudSaveQueue: CloudSaveQueue;
  setLangCode: (langCode: string) => void;
};

export const useEditorLifecycleSync = ({
  excalidrawAPI,
  currentSceneIdRef,
  cloudSaveQueue,
  setLangCode,
}: UseEditorLifecycleSyncOptions) => {
  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }

    const syncData = debounce(() => {
      if (isTestEnv()) {
        return;
      }
      if (!document.hidden) {
        // For cloud SQLite scenes, scene content sync across browser tabs is handled
        // securely by subscribeCloudTabSync via BroadcastChannel per sceneId.
        // We must NEVER overwrite currentSceneId with global localStorage.
        if (
          !currentSceneIdRef.current &&
          isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_DATA_STATE)
        ) {
          const localDataState = importFromLocalStorage();
          setLangCode(getPreferredLanguage());
          excalidrawAPI.updateScene({
            ...localDataState,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        }

        LibraryIndexedDBAdapter.load().then((data) => {
          if (data) {
            excalidrawAPI.updateLibrary({
              libraryItems: data.libraryItems,
            });
          }
        });

        if (
          !currentSceneIdRef.current &&
          isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_FILES)
        ) {
          const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
          const currFiles = excalidrawAPI.getFiles();
          const fileIds =
            elements?.reduce((acc, element) => {
              if (
                isInitializedImageElement(element) &&
                // only load and update images that aren't already loaded
                !currFiles[element.fileId]
              ) {
                return acc.concat(element.fileId);
              }
              return acc;
            }, [] as FileId[]) || [];
          if (fileIds.length) {
            LocalData.fileStorage
              .getFiles(fileIds)
              .then(({ loadedFiles, erroredFiles }) => {
                if (loadedFiles.length) {
                  excalidrawAPI.addFiles(loadedFiles);
                }
                updateStaleImageStatuses({
                  excalidrawAPI,
                  erroredFiles,
                  elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
                });
              });
          }
        }
      }
    }, SYNC_BROWSER_TABS_TIMEOUT);

    const flushCloudSave = () => {
      LocalData.flushSave();
      const sceneId = currentSceneIdRef.current;
      if (sceneId) {
        void cloudSaveQueue.flush(sceneId);
      }
    };

    const onUnload = () => {
      cloudSaveQueue.protectPendingSnapshotsForUnload(true);
      flushCloudSave();
    };

    const visibilityChange = (event: FocusEvent | Event) => {
      if (event.type === EVENT.BLUR || document.hidden) {
        flushCloudSave();
      }
      if (
        event.type === EVENT.VISIBILITY_CHANGE ||
        event.type === EVENT.FOCUS
      ) {
        syncData();
      }
    };

    window.addEventListener(EVENT.UNLOAD, onUnload, false);
    window.addEventListener("pagehide", onUnload, false);
    window.addEventListener(EVENT.BLUR, visibilityChange, false);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, visibilityChange, false);
    window.addEventListener(EVENT.FOCUS, visibilityChange, false);
    return () => {
      syncData.cancel();
      window.removeEventListener(EVENT.UNLOAD, onUnload, false);
      window.removeEventListener("pagehide", onUnload, false);
      window.removeEventListener(EVENT.BLUR, visibilityChange, false);
      window.removeEventListener(EVENT.FOCUS, visibilityChange, false);
      document.removeEventListener(
        EVENT.VISIBILITY_CHANGE,
        visibilityChange,
        false,
      );
    };
  }, [excalidrawAPI, setLangCode, cloudSaveQueue, currentSceneIdRef]);

  useEffect(() => {
    const unloadHandler = (event: BeforeUnloadEvent) => {
      LocalData.flushSave();
      cloudSaveQueue.protectPendingSnapshotsForUnload(true);
      const sceneId = currentSceneIdRef.current;
      if (sceneId) {
        void cloudSaveQueue.flush(sceneId);
      }

      if (sceneId && cloudSaveQueue.hasPending(sceneId)) {
        preventUnload(event);
      }

      if (
        excalidrawAPI &&
        LocalData.fileStorage.shouldPreventUnload(
          excalidrawAPI.getSceneElements(),
        )
      ) {
        if (import.meta.env.VITE_APP_DISABLE_PREVENT_UNLOAD !== "true") {
          preventUnload(event);
        } else {
          console.warn(
            "preventing unload disabled (VITE_APP_DISABLE_PREVENT_UNLOAD)",
          );
        }
      }
    };
    window.addEventListener(EVENT.BEFORE_UNLOAD, unloadHandler);
    return () => {
      window.removeEventListener(EVENT.BEFORE_UNLOAD, unloadHandler);
    };
  }, [excalidrawAPI, cloudSaveQueue, currentSceneIdRef]);

  const onExport: Required<ExcalidrawProps>["onExport"] = useCallback(
    async function* () {
      let snapshot = FileStatusStore.getSnapshot();
      const { pending, total } = FileStatusStore.getPendingCount(
        snapshot.value,
      );
      if (pending === 0) {
        return;
      }

      yield {
        type: "progress",
        progress: (total - pending) / total,
        message: `Loading images (${total - pending}/${total})...`,
      };

      while (true) {
        snapshot = await FileStatusStore.pull(snapshot.version);
        const { pending: nowPending, total: nowTotal } =
          FileStatusStore.getPendingCount(snapshot.value);

        yield {
          type: "progress",
          progress: (nowTotal - nowPending) / nowTotal,
          message: `Loading images (${nowTotal - nowPending}/${nowTotal})...`,
        };

        if (nowPending === 0) {
          await new Promise((r) => setTimeout(r, 500));
          yield {
            type: "progress",
            message: `Preparing export...`,
          };
          return;
        }
      }
    },
    [],
  );

  return { onExport };
};
