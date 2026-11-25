import {
  Excalidraw,
  CaptureUpdateAction,
  ExcalidrawAPIProvider,
  useExcalidrawAPI,
} from "@excalidraw/excalidraw";
import { ErrorDialog } from "@excalidraw/excalidraw/components/ErrorDialog";
import {
  EVENT,
  debounce,
  isTestEnv,
  resolvablePromise,
  isDevEnv,
} from "@excalidraw/common";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { t } from "@excalidraw/excalidraw/i18n";

import { isElementLink } from "@excalidraw/element";
import {
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import { newElementWith } from "@excalidraw/element";
import { isInitializedImageElement } from "@excalidraw/element";
import { useHandleLibrary } from "@excalidraw/excalidraw/data/library";

import type {
  FileId,
  NonDeletedExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
  UIAppState,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import type { ResolutionType } from "@excalidraw/common/utility-types";
import type { ResolvablePromise } from "@excalidraw/common/utils";

import CustomStats from "./CustomStats";
import { useAtomValue } from "./app-jotai";
import { STORAGE_KEYS } from "./app_constants";
import { AppFooter } from "./components/AppFooter";
import { AppMainMenu } from "./components/AppMainMenu";
import { AppWelcomeScreen } from "./components/AppWelcomeScreen";
import {
  checkAuthStatus,
  saveFilesToCloud,
  fetchCloudScene,
  fetchCloudScenePage,
  fetchCloudFiles,
  createCloudScene,
  markCloudSceneOpened,
  saveCloudSceneThumbnail,
} from "./data/cloudStorage";

import type { CloudSceneData } from "./data/cloudStorage";

import { updateStaleImageStatuses } from "./data/FileManager";
import { FileStatusStore } from "./data/fileStatusStore";
import { prepareCloudSaveSnapshot } from "./data/prepareCloudSaveSnapshot";
import { importFromLocalStorage } from "./data/localStorage";

import {
  LibraryIndexedDBAdapter,
  LibraryLocalStorageMigrationAdapter,
  LocalData,
  localStorageQuotaExceededAtom,
} from "./data/LocalData";
import { useHandleAppTheme } from "./useHandleAppTheme";
import { useAppLangCode } from "./app-language/language-state";
import DebugCanvas, {
  debugRenderer,
  isVisualDebuggerEnabled,
  loadSavedDebugState,
} from "./components/DebugCanvas";
import { createSceneThumbnail } from "./data/sceneThumbnail";
import {
  LatestThumbnailSaveQueue,
  type ThumbnailSnapshot,
} from "./data/thumbnailSaveQueue";

import { EditorTopRightUI } from "./components/EditorTopRightUI";
import { EditorCommandPalette } from "./components/EditorCommandPalette";
import { AppSidebar } from "./components/AppSidebar";
import { LazyOverwriteConfirmDialog } from "./components/LazyOverwriteConfirmDialog";
import { useEditorLifecycleSync } from "./data/useEditorLifecycleSync";
import {
  clearObsoleteLocalFiles,
  getCloudFileIds,
  initializeScene,
  restoreCloudScene,
  type InitializeSceneResult,
} from "./data/editorSceneInit";
import {
  CloudSaveQueue,
  getCloudPersistenceSignature,
  getCloudSceneLoadSignatures,
  getCloudSceneRecoveryData,
  subscribeCloudRealtime,
  subscribeCloudTabSync,
  type CloudSaveStatus,
} from "./data/cloudSync";

import type { CloudSaveSnapshot } from "./data/cloudSync";
import { createCloudSceneRefreshGuard } from "./data/cloudSceneRefresh";

const LazyAuthDialog = lazy(async () => {
  const { AuthDialog } = await import("./components/AuthDialog");
  return { default: AuthDialog };
});

const LazyCloudConflictDialog = lazy(async () => {
  const { CloudConflictDialog } =
    await import("./components/CloudConflictDialog");
  return { default: CloudConflictDialog };
});

const LazyCloudSceneDeletedDialog = lazy(async () => {
  const { CloudSceneDeletedDialog } =
    await import("./components/CloudSceneDeletedDialog");
  return { default: CloudSceneDeletedDialog };
});

window.EXCALIDRAW_THROTTLE_RENDER = true;

let isSelfEmbedding = false;

if (window.self !== window.top) {
  try {
    const parentUrl = new URL(document.referrer);
    const currentUrl = new URL(window.location.href);
    if (parentUrl.origin === currentUrl.origin) {
      isSelfEmbedding = true;
    }
  } catch (error) {
    // ignore
  }
}

const ExcalidrawWrapper = (props: {
  onNavigateHome?: () => void;
  initialCloudScene?: CloudSceneData | null;
}) => {
  const { initialCloudScene, onNavigateHome } = props;
  const excalidrawAPI = useExcalidrawAPI();

  const [errorMessage, setErrorMessage] = useState("");

  const { editorTheme, appTheme, setAppTheme } = useHandleAppTheme();

  const [langCode, setLangCode] = useAppLangCode();

  // initial state
  // ---------------------------------------------------------------------------

  const initialStatePromiseRef = useRef<{
    promise: ResolvablePromise<ExcalidrawInitialDataState | null>;
  }>({ promise: null! });
  if (!initialStatePromiseRef.current.promise) {
    initialStatePromiseRef.current.promise =
      resolvablePromise<ExcalidrawInitialDataState | null>();
  }

  const debugCanvasRef = useRef<HTMLCanvasElement>(null);

  useHandleLibrary({
    excalidrawAPI,
    adapter: LibraryIndexedDBAdapter,
    // TODO maybe remove this in several months (shipped: 24-03-11)
    migrationAdapter: LibraryLocalStorageMigrationAdapter,
  });

  const [, forceRefresh] = useState(false);

  useEffect(() => {
    if (isDevEnv()) {
      const debugState = loadSavedDebugState();

      if (debugState.enabled && !window.visualDebug) {
        window.visualDebug = {
          data: [],
        };
      } else {
        delete window.visualDebug;
      }
      forceRefresh((prev) => !prev);
    }
  }, [excalidrawAPI]);

  // Cloud Whiteboard (SQLite) State & Handlers
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [cloudBootstrapError, setCloudBootstrapError] = useState("");
  const authSceneIdsRef = useRef(new Set<string>());
  const [cloudConflicts, setCloudConflicts] = useState<
    Array<{
      sceneId: string;
      snapshot: CloudSaveSnapshot;
    }>
  >([]);
  const [isCloudConflictDismissed, setIsCloudConflictDismissed] =
    useState(false);
  const [deletedRecoveryVersion, setDeletedRecoveryVersion] = useState(0);
  const [isRecoveringDeletedScene, setIsRecoveringDeletedScene] =
    useState(false);
  const [currentSceneId, setCurrentSceneId] = useState<string | null>(null);
  const [cloudSaveStatus, setCloudSaveStatus] =
    useState<CloudSaveStatus>("idle");
  const currentSceneIdRef = useRef<string | null>(null);
  const cloudPersistenceSignatureRef = useRef<string | null>(null);
  const cloudPersistenceDirtyRef = useRef(true);
  const savedStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const isApplyingCloudSceneRef = useRef(false);
  const cloudSceneLoadingRef = useRef<{
    loadId: number;
    sceneId: string;
    edited: boolean;
  } | null>(null);
  const cloudBootstrapPromiseRef = useRef<Promise<void> | null>(null);
  const cloudSceneLoadIdRef = useRef(0);
  const cloudFileLoadControllerRef = useRef<AbortController | null>(null);
  const cloudSceneViewportTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const thumbnailVersionRef = useRef(0);
  const thumbnailSaveQueue = useMemo(
    () => new LatestThumbnailSaveQueue<ThumbnailSnapshot>(),
    [],
  );
  const authWaitersRef = useRef<Array<(authenticated: boolean) => void>>([]);
  const initialSceneDataRef = useRef<ResolutionType<
    typeof initializeScene
  > | null>(null);
  const initialSceneInitializedRef = useRef(false);
  const initialSceneImagesLoadedRef = useRef(false);

  const setActiveCloudScene = useCallback((sceneId: string | null) => {
    const changed = currentSceneIdRef.current !== sceneId;
    currentSceneIdRef.current = sceneId;
    if (changed) {
      cloudPersistenceSignatureRef.current = null;
      cloudPersistenceDirtyRef.current = true;
      if (savedStatusTimerRef.current) {
        clearTimeout(savedStatusTimerRef.current);
        savedStatusTimerRef.current = null;
      }
      setCloudSaveStatus("idle");
    }
    setCurrentSceneId(sceneId);
  }, []);

  const saveThumbnailDebounced = useMemo(
    () =>
      debounce(
        (snapshot: ThumbnailSnapshot) =>
          thumbnailSaveQueue.schedule(
            snapshot,
            createSceneThumbnail,
            (sceneId, blob) =>
              saveCloudSceneThumbnail(
                sceneId,
                blob,
                snapshot.thumbnailVersion,
                snapshot.revision,
              ),
            (error) => console.warn("画板缩略图保存失败", error),
          ),
        1500,
      ),
    [thumbnailSaveQueue],
  );

  const cloudSaveQueue = useMemo(
    () =>
      new CloudSaveQueue({
        onSnapshotSaved: (snapshot, revision) => {
          const thumbnailVersion = Math.max(
            Date.now(),
            thumbnailVersionRef.current + 1,
          );
          thumbnailVersionRef.current = thumbnailVersion;
          saveThumbnailDebounced({ ...snapshot, revision, thumbnailVersion });
        },
        onAuthRequired: (sceneId) => {
          authSceneIdsRef.current.add(sceneId);
          setIsAuthOpen(true);
        },
        onConflict: (sceneId, snapshot) => {
          setCloudConflicts((current) => {
            const index = current.findIndex((item) => item.sceneId === sceneId);
            if (index < 0) {
              return [...current, { sceneId, snapshot }];
            }
            return current.map((item, itemIndex) =>
              itemIndex === index ? { sceneId, snapshot } : item,
            );
          });
          setIsCloudConflictDismissed(false);
        },
        onSceneUnavailable: () => {
          setDeletedRecoveryVersion((version) => version + 1);
        },
        onError: (error) => {
          setCloudSaveStatus("error");
          console.error("云端自动保存失败", error);
        },
        onStatusChange: (sceneId, status) => {
          if (currentSceneIdRef.current === sceneId) {
            setCloudSaveStatus(status);
            if (status === "saved") {
              if (savedStatusTimerRef.current) {
                clearTimeout(savedStatusTimerRef.current);
              }
              savedStatusTimerRef.current = setTimeout(() => {
                if (currentSceneIdRef.current === sceneId) {
                  setCloudSaveStatus("idle");
                }
                savedStatusTimerRef.current = null;
              }, 2000);
            }
          }
        },
      }),
    [saveThumbnailDebounced],
  );
  const deletedRecoveries = useMemo(
    () => cloudSaveQueue.getUnavailableScenes(),
    [cloudSaveQueue, deletedRecoveryVersion],
  );

  useEffect(() => {
    cloudSaveQueue.activate();
    return () => cloudSaveQueue.dispose();
  }, [cloudSaveQueue]);

  useEffect(
    () => () => {
      cloudFileLoadControllerRef.current?.abort();
      cloudFileLoadControllerRef.current = null;
      if (savedStatusTimerRef.current) {
        clearTimeout(savedStatusTimerRef.current);
        savedStatusTimerRef.current = null;
      }
      if (cloudSceneViewportTimerRef.current) {
        clearTimeout(cloudSceneViewportTimerRef.current);
        cloudSceneViewportTimerRef.current = null;
      }
      saveThumbnailDebounced.cancel();
      thumbnailSaveQueue.cancel();
    },
    [saveThumbnailDebounced, thumbnailSaveQueue],
  );

  useEffect(() => {
    const retryCloudSave = () => {
      cloudSaveQueue.retryPending();
      const sceneId = currentSceneIdRef.current;
      if (sceneId) {
        void cloudSaveQueue.flush(sceneId);
      }
    };
    window.addEventListener("online", retryCloudSave);
    return () => window.removeEventListener("online", retryCloudSave);
  }, [cloudSaveQueue]);

  const loadCloudFilesIntoScene = useCallback(
    async (
      elements: readonly any[],
      sceneId?: string,
      loadId = cloudSceneLoadIdRef.current,
      revalidate = true,
    ) => {
      if (!excalidrawAPI) {
        return;
      }
      cloudFileLoadControllerRef.current?.abort();
      cloudFileLoadControllerRef.current = null;
      const sceneFileIds = getCloudFileIds(elements);
      const existingFiles = excalidrawAPI.getFiles();
      const fileIds = sceneFileIds.filter(
        (fileId) => revalidate || !existingFiles[fileId]?.dataURL,
      );
      if (!fileIds.length) {
        clearObsoleteLocalFiles(sceneFileIds);
        return;
      }
      const loadToken = FileStatusStore.beginLoading(fileIds);
      const loadController = new AbortController();
      cloudFileLoadControllerRef.current = loadController;
      try {
        const { loadedFiles, erroredFiles } = await fetchCloudFiles(fileIds, {
          signal: loadController.signal,
          existingFiles,
        });
        if (
          (sceneId &&
            currentSceneIdRef.current &&
            currentSceneIdRef.current !== sceneId) ||
          loadId !== cloudSceneLoadIdRef.current
        ) {
          FileStatusStore.cancelLoading(loadToken);
          return;
        }
        // A local import can replace an attachment while its remote version
        // is loading. Keep that edit rather than applying the older response.
        const currentFiles = excalidrawAPI.getFiles();
        excalidrawAPI.addFiles(
          loadedFiles.filter(
            (file) => currentFiles[file.id] === existingFiles[file.id],
          ),
          { replace: true },
        );
        updateStaleImageStatuses({
          excalidrawAPI,
          erroredFiles,
          elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
        });
        FileStatusStore.finishLoading(loadToken, [
          ...loadedFiles.map(
            (file) => [file.id, "loaded"] as [FileId, "loaded"],
          ),
          ...[...erroredFiles.keys()].map(
            (id) => [id, "error"] as [FileId, "error"],
          ),
        ]);
        clearObsoleteLocalFiles(sceneFileIds);
      } catch (error: any) {
        const isStale = Boolean(
          (sceneId &&
            currentSceneIdRef.current &&
            currentSceneIdRef.current !== sceneId) ||
          loadId !== cloudSceneLoadIdRef.current,
        );
        if (
          !isStale &&
          !loadController.signal.aborted &&
          error?.status === 401
        ) {
          const blockedSceneId = sceneId || currentSceneIdRef.current;
          if (blockedSceneId) {
            authSceneIdsRef.current.add(blockedSceneId);
          }
          setIsAuthOpen(true);
        }
        if (isStale || loadController.signal.aborted) {
          FileStatusStore.cancelLoading(loadToken);
        } else {
          FileStatusStore.finishLoading(
            loadToken,
            fileIds.map((id) => [id, "error"] as [FileId, "error"]),
          );
        }
      } finally {
        if (cloudFileLoadControllerRef.current === loadController) {
          cloudFileLoadControllerRef.current = null;
        }
      }
    },
    [excalidrawAPI],
  );

  const enqueueCloudSceneSnapshot = useCallback(
    (
      sceneId: string,
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      const referencedFiles: BinaryFiles = {};
      const fileIds = getCloudFileIds(elements);
      for (const fileId of fileIds) {
        const file = files[fileId];
        if (file) {
          referencedFiles[fileId] = file;
        }
      }
      const name = excalidrawAPI?.getName() || "未命名白板";
      const persistedAppState = {
        viewBackgroundColor: appState.viewBackgroundColor,
        gridSize: appState.gridSize,
      };
      const persistedElements = elements.filter(
        (element: any) => element?.isDeleted !== true,
      );
      const signature = getCloudPersistenceSignature(
        name,
        persistedElements,
        persistedAppState,
        referencedFiles,
        fileIds,
      );
      if (signature === cloudPersistenceSignatureRef.current) {
        cloudPersistenceDirtyRef.current = false;
        return;
      }

      cloudPersistenceSignatureRef.current = signature;
      cloudPersistenceDirtyRef.current = false;
      cloudSaveQueue.enqueue({
        sceneId,
        name,
        elements: persistedElements,
        appState: persistedAppState,
        files: referencedFiles,
      });
    },
    [cloudSaveQueue, excalidrawAPI],
  );

  const loadSelectedCloudScene = useCallback(
    async (
      sceneId: string,
      updateUrl = true,
      prefetchedCloudScene?: CloudSceneData,
      recoveredSnapshot?: CloudSaveSnapshot | null,
    ) => {
      const loadId = ++cloudSceneLoadIdRef.current;
      cloudFileLoadControllerRef.current?.abort();
      cloudFileLoadControllerRef.current = null;
      const canApplyRefresh =
        excalidrawAPI &&
        currentSceneIdRef.current === sceneId &&
        !recoveredSnapshot
          ? createCloudSceneRefreshGuard(() => {
              const appState = excalidrawAPI.getAppState();
              return {
                sceneId: currentSceneIdRef.current,
                signature: getCloudPersistenceSignature(
                  excalidrawAPI.getName() || "未命名白板",
                  excalidrawAPI
                    .getSceneElements()
                    .filter((element) => !element.isDeleted),
                  {
                    viewBackgroundColor: appState.viewBackgroundColor,
                    gridSize: appState.gridSize,
                  },
                  excalidrawAPI.getFiles(),
                ),
                hasPending: cloudSaveQueue.hasPending(sceneId),
              };
            })
          : null;
      cloudSceneLoadingRef.current = null;
      isApplyingCloudSceneRef.current = false;
      if (cloudSceneViewportTimerRef.current) {
        clearTimeout(cloudSceneViewportTimerRef.current);
        cloudSceneViewportTimerRef.current = null;
      }
      const remoteData =
        prefetchedCloudScene?.id === sceneId
          ? prefetchedCloudScene
          : await fetchCloudScene(sceneId);
      // The pending local edit is the scene the user must continue editing.
      // Loading only the server baseline would let the next edit overwrite
      // the recovered save, even after that save succeeds.
      const cloudData = getCloudSceneRecoveryData(
        remoteData,
        recoveredSnapshot,
      );
      if (!excalidrawAPI || excalidrawAPI.isDestroyed) {
        throw new Error("编辑器尚未初始化");
      }
      if (loadId !== cloudSceneLoadIdRef.current) {
        return cloudData;
      }
      // An edit can start and even finish saving while the fetch is in flight.
      // Keep that canvas and its queue revision rather than applying stale data.
      if (canApplyRefresh && !canApplyRefresh()) {
        return cloudData;
      }

      const elements = restoreElements(cloudData.elements, null, {
        repairBindings: true,
        deleteInvisibleElements: true,
      });
      const restoredAppState = restoreAppState(
        { ...cloudData.appState, name: cloudData.name },
        excalidrawAPI.getAppState(),
      );

      setCloudBootstrapError("");
      if (updateUrl) {
        if (loadId !== cloudSceneLoadIdRef.current) {
          return cloudData;
        }
        window.history.replaceState(
          {},
          "",
          `${window.location.pathname}?id=${encodeURIComponent(sceneId)}`,
        );
      }

      isApplyingCloudSceneRef.current = true;
      cloudSaveQueue.setRevision(
        sceneId,
        recoveredSnapshot?.baseRevision ?? cloudData.revision,
      );
      setActiveCloudScene(sceneId);
      cloudSceneLoadingRef.current = {
        loadId,
        sceneId,
        edited: false,
      };
      let editedDuringLoad = false;
      try {
        if (loadId !== cloudSceneLoadIdRef.current) {
          return cloudData;
        }
        excalidrawAPI.updateScene({
          elements,
          appState: restoredAppState,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        if (recoveredSnapshot) {
          excalidrawAPI.addFiles(Object.values(recoveredSnapshot.files), {
            replace: true,
          });
        }
        // Recovered files are unsaved local edits, so only fetch missing files.
        await loadCloudFilesIntoScene(
          elements,
          sceneId,
          loadId,
          !recoveredSnapshot,
        );
        editedDuringLoad = Boolean(
          cloudSceneLoadingRef.current?.loadId === loadId &&
          cloudSceneLoadingRef.current.edited,
        );
        if (cloudData.elements.length) {
          cloudSceneViewportTimerRef.current = setTimeout(() => {
            cloudSceneViewportTimerRef.current = null;
            if (
              loadId === cloudSceneLoadIdRef.current &&
              currentSceneIdRef.current === sceneId &&
              !excalidrawAPI.isDestroyed
            ) {
              excalidrawAPI.setViewport({
                target: cloudData.elements,
                fit: "scale-down",
                animation: true,
              });
            }
          }, 50);
        }
      } finally {
        if (loadId === cloudSceneLoadIdRef.current) {
          isApplyingCloudSceneRef.current = false;
          cloudSceneLoadingRef.current = null;
        }
      }
      if (loadId !== cloudSceneLoadIdRef.current) {
        return cloudData;
      }
      void markCloudSceneOpened(sceneId).catch((error) => {
        console.warn("最近打开时间更新失败", error);
      });
      const currentElements = excalidrawAPI.getSceneElementsIncludingDeleted();
      const currentAppState = excalidrawAPI.getAppState();
      const currentFiles = excalidrawAPI.getFiles();
      const { baselineSignature, hasChanges } = getCloudSceneLoadSignatures(
        {
          name: cloudData.name,
          elements: elements.filter(
            (element: any) => element?.isDeleted !== true,
          ),
          appState: {
            viewBackgroundColor: restoredAppState.viewBackgroundColor,
            gridSize: restoredAppState.gridSize,
          },
          // Loading can add the remote files while the user is editing. Use
          // the same completed file set for both signatures so hydration alone
          // does not look like an edit.
          files: currentFiles,
        },
        {
          name: excalidrawAPI.getName() || "未命名白板",
          elements: currentElements.filter(
            (element: any) => element?.isDeleted !== true,
          ),
          appState: {
            viewBackgroundColor: currentAppState.viewBackgroundColor,
            gridSize: currentAppState.gridSize,
          },
          files: currentFiles,
        },
        editedDuringLoad,
      );
      cloudPersistenceSignatureRef.current = baselineSignature;
      cloudPersistenceDirtyRef.current = false;
      if (editedDuringLoad && hasChanges) {
        cloudPersistenceDirtyRef.current = true;
        enqueueCloudSceneSnapshot(
          sceneId,
          currentElements,
          currentAppState,
          currentFiles,
        );
      }
      return cloudData;
    },
    [
      cloudSaveQueue,
      excalidrawAPI,
      enqueueCloudSceneSnapshot,
      loadCloudFilesIntoScene,
      setActiveCloudScene,
    ],
  );

  const createCurrentCloudSnapshot = useCallback(() => {
    const sceneId = currentSceneIdRef.current;
    if (!sceneId || !excalidrawAPI) {
      return null;
    }
    const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
    const appState = excalidrawAPI.getAppState();
    const allFiles = excalidrawAPI.getFiles();
    const files: BinaryFiles = {};
    for (const fileId of getCloudFileIds(elements)) {
      const file = allFiles[fileId];
      if (file) {
        files[fileId] = file;
      }
    }
    return {
      sceneId,
      name: excalidrawAPI.getName() || "未命名白板",
      elements,
      appState: {
        viewBackgroundColor: appState.viewBackgroundColor,
        gridSize: appState.gridSize,
      },
      files,
    } as CloudSaveSnapshot;
  }, [excalidrawAPI]);

  const saveCurrentCloudScene = useCallback(async () => {
    const snapshot = createCurrentCloudSnapshot();
    if (!snapshot || !excalidrawAPI) {
      return false;
    }
    const loadId = cloudSceneLoadIdRef.current;
    try {
      const persistedSnapshot = await prepareCloudSaveSnapshot(
        createCurrentCloudSnapshot,
        () =>
          currentSceneIdRef.current === snapshot.sceneId &&
          cloudSceneLoadIdRef.current === loadId,
      );
      const signature = getCloudPersistenceSignature(
        persistedSnapshot.name,
        persistedSnapshot.elements,
        persistedSnapshot.appState,
        persistedSnapshot.files,
      );
      // Explicit save/navigation also flushes recovered or queued edits, but
      // opening and leaving an unchanged board must not increment its revision.
      if (signature !== cloudPersistenceSignatureRef.current) {
        cloudSaveQueue.enqueue(persistedSnapshot);
      }
      const status = await cloudSaveQueue.flush(persistedSnapshot.sceneId);
      if (
        status === "saved" ||
        (status === "idle" &&
          !cloudSaveQueue.hasPending(persistedSnapshot.sceneId))
      ) {
        const currentSnapshot = createCurrentCloudSnapshot();
        // A later edit may have been queued while flush awaited the network.
        // Do not replace its baseline or clear its dirty flag with this save.
        if (
          currentSnapshot?.sceneId === snapshot.sceneId &&
          cloudSceneLoadIdRef.current === loadId &&
          getCloudPersistenceSignature(
            currentSnapshot.name,
            currentSnapshot.elements.filter((element) => !element.isDeleted),
            currentSnapshot.appState,
            currentSnapshot.files,
          ) === signature
        ) {
          cloudPersistenceSignatureRef.current = signature;
          cloudPersistenceDirtyRef.current = false;
        }
        // Saving the body schedules its preview with the committed revision.
        // Flush that debounce afterwards so navigation retains the latest preview.
        await saveThumbnailDebounced.flush();
        await thumbnailSaveQueue.flush();
        return true;
      }
      return false;
    } catch (error: any) {
      setCloudSaveStatus("error");
      setErrorMessage(error?.message || "保存云端画板失败");
      return false;
    }
  }, [
    cloudSaveQueue,
    createCurrentCloudSnapshot,
    excalidrawAPI,
    saveThumbnailDebounced,
    thumbnailSaveQueue,
  ]);

  const bootstrapCloud = useCallback(() => {
    if (cloudBootstrapPromiseRef.current) {
      return cloudBootstrapPromiseRef.current;
    }

    const run = (async () => {
      if (!excalidrawAPI) {
        return;
      }

      setCloudBootstrapError("");
      await initialStatePromiseRef.current.promise;
      await cloudSaveQueue.ready();
      const status = await checkAuthStatus();
      if (status.authRequired && !status.authenticated) {
        setIsAuthOpen(true);
        return;
      }

      const requestedId = new URLSearchParams(window.location.search).get("id");
      if (requestedId) {
        try {
          await loadSelectedCloudScene(
            requestedId,
            false,
            initialSceneDataRef.current?.cloudScene,
            cloudSaveQueue.getPendingSnapshot(requestedId),
          );
          cloudSaveQueue.resumePending();
          return;
        } catch (error: any) {
          if (error?.status !== 400 && error?.status !== 404) {
            throw error;
          }
          window.history.replaceState({}, "", window.location.pathname);
        }
      }

      const page = await fetchCloudScenePage({ limit: 1 });
      let scene = page.items[0];
      if (!scene) {
        const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
        const files: BinaryFiles = {};
        for (const fileId of getCloudFileIds(elements)) {
          const file = excalidrawAPI.getFiles()[fileId];
          if (file) {
            files[fileId] = file;
          }
        }
        await saveFilesToCloud(files);
        scene = await createCloudScene({
          name: excalidrawAPI.getName() || "我的画板",
          elements,
          appState: {
            viewBackgroundColor:
              excalidrawAPI.getAppState().viewBackgroundColor,
            gridSize: excalidrawAPI.getAppState().gridSize,
          },
        });
      }
      await loadSelectedCloudScene(
        scene.id,
        true,
        undefined,
        cloudSaveQueue.getPendingSnapshot(scene.id),
      );
      cloudSaveQueue.resumePending();
    })();

    cloudBootstrapPromiseRef.current = run;
    void run
      .catch((error: any) => {
        if (error?.status === 401) {
          setIsAuthOpen(true);
        } else {
          setCloudBootstrapError(error?.message || "初始化云端画板失败");
        }
      })
      .finally(() => {
        if (cloudBootstrapPromiseRef.current === run) {
          cloudBootstrapPromiseRef.current = null;
        }
      });
    return run;
  }, [cloudSaveQueue, excalidrawAPI, loadSelectedCloudScene]);

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    void bootstrapCloud();
  }, [bootstrapCloud, excalidrawAPI]);

  const handleSceneDeleted = useCallback(
    async (sceneId: string) => {
      await cloudSaveQueue.ready();
      const recovery = cloudSaveQueue.preserveForRecovery(sceneId);
      if (recovery) {
        setDeletedRecoveryVersion((version) => version + 1);
      } else {
        cloudSaveQueue.cancel(sceneId);
      }
      if (currentSceneIdRef.current !== sceneId) {
        return;
      }
      setActiveCloudScene(null);
      window.history.replaceState({}, "", window.location.pathname);
      try {
        const page = await fetchCloudScenePage({ limit: 1 });
        const nextScene =
          page.items[0] || (await createCloudScene({ name: "我的画板" }));
        await loadSelectedCloudScene(nextScene.id);
      } catch (error: any) {
        if (error?.status === 401) {
          setIsAuthOpen(true);
        } else {
          setErrorMessage(error?.message || "删除画板后切换失败");
        }
      }
    },
    [cloudSaveQueue, loadSelectedCloudScene, setActiveCloudScene],
  );

  const resolveCloudConflict = useCallback(
    async (keepLocal: boolean) => {
      const cloudConflict = cloudConflicts[0];
      if (!cloudConflict) {
        return;
      }
      try {
        const remote = await fetchCloudScene(cloudConflict.sceneId);
        if (!keepLocal && currentSceneIdRef.current === cloudConflict.sceneId) {
          await loadSelectedCloudScene(cloudConflict.sceneId, false);
        }
        cloudSaveQueue.resolveConflict(
          cloudConflict.sceneId,
          remote.revision,
          keepLocal,
        );
        setCloudConflicts((current) =>
          current.filter((item) => item.sceneId !== cloudConflict.sceneId),
        );
        setIsCloudConflictDismissed(false);
      } catch (error: any) {
        if (error?.status === 401) {
          authSceneIdsRef.current.add(cloudConflict.sceneId);
          setIsAuthOpen(true);
        } else if (error?.status === 404) {
          void handleSceneDeleted(cloudConflict.sceneId);
          setCloudConflicts((current) =>
            current.filter((item) => item.sceneId !== cloudConflict.sceneId),
          );
          setIsCloudConflictDismissed(false);
        } else {
          setErrorMessage(error?.message || "处理云端冲突失败");
        }
      }
    },
    [
      cloudConflicts,
      cloudSaveQueue,
      handleSceneDeleted,
      loadSelectedCloudScene,
    ],
  );

  const recoverDeletedScene = useCallback(async () => {
    const recovery = deletedRecoveries[0];
    if (!recovery || isRecoveringDeletedScene) {
      return;
    }
    setIsRecoveringDeletedScene(true);
    try {
      const snapshot = cloudSaveQueue.getPendingSnapshot(recovery.sceneId);
      if (!snapshot) {
        throw new Error("找不到待恢复的本地画板内容。");
      }
      const fileIdMap = new Map<string, FileId>();
      const files: BinaryFiles = {};
      for (const file of Object.values(snapshot.files)) {
        const fileId = crypto.randomUUID() as FileId;
        fileIdMap.set(file.id, fileId);
        files[fileId] = { ...file, id: fileId };
      }
      const elements = snapshot.elements.map((element) => {
        if (element.type !== "image" || !element.fileId) {
          return element;
        }
        const fileId = fileIdMap.get(element.fileId);
        if (!fileId) {
          throw new Error(
            "恢复画板时找不到图片文件，请保留草稿并检查浏览器存储。",
          );
        }
        return { ...element, fileId };
      });
      await saveFilesToCloud(files, { forceUpload: true });
      const scene = await createCloudScene({
        name: `${snapshot.name}（恢复）`.slice(0, 120),
        elements,
        appState: snapshot.appState,
      });
      cloudSaveQueue.cancel(recovery.sceneId);
      setDeletedRecoveryVersion((version) => version + 1);
      await loadSelectedCloudScene(scene.id);
    } catch (error: any) {
      setErrorMessage(error?.message || "恢复已删除画板失败");
    } finally {
      setIsRecoveringDeletedScene(false);
    }
  }, [
    cloudSaveQueue,
    deletedRecoveries,
    isRecoveringDeletedScene,
    loadSelectedCloudScene,
  ]);

  const discardDeletedSceneRecovery = useCallback(() => {
    const recovery = deletedRecoveries[0];
    if (!recovery || isRecoveringDeletedScene) {
      return;
    }
    cloudSaveQueue.cancel(recovery.sceneId);
    setDeletedRecoveryVersion((version) => version + 1);
  }, [cloudSaveQueue, deletedRecoveries, isRecoveringDeletedScene]);

  useEffect(() => {
    return subscribeCloudTabSync((message) => {
      if (message.type === "scene_saved") {
        if (
          currentSceneIdRef.current === message.sceneId &&
          !cloudSaveQueue.hasPending(message.sceneId)
        ) {
          void loadSelectedCloudScene(message.sceneId, false);
        } else if (!cloudSaveQueue.hasPending(message.sceneId)) {
          cloudSaveQueue.setRevision(message.sceneId, message.revision);
        }
      } else if (message.type === "scene_renamed") {
        if (
          currentSceneIdRef.current === message.sceneId &&
          excalidrawAPI &&
          !cloudSaveQueue.hasPending(message.sceneId)
        ) {
          cloudSaveQueue.setRevision(message.sceneId, message.revision);
          excalidrawAPI.updateScene({
            appState: { name: message.name },
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        } else if (!cloudSaveQueue.hasPending(message.sceneId)) {
          cloudSaveQueue.setRevision(message.sceneId, message.revision);
        }
      } else if (message.type === "scene_deleted") {
        if (currentSceneIdRef.current === message.sceneId) {
          void handleSceneDeleted(message.sceneId);
        }
      }
    });
  }, [
    cloudSaveQueue,
    excalidrawAPI,
    handleSceneDeleted,
    loadSelectedCloudScene,
  ]);

  useEffect(() => {
    const sceneId = currentSceneId;
    if (!sceneId) {
      return;
    }
    return subscribeCloudRealtime(sceneId, (event) => {
      if (event.type !== "scene_changed" || event.sceneId !== sceneId) {
        return;
      }
      if (event.changeKind === "thumbnail") {
        return;
      }
      if (event.changeKind === "deleted") {
        void handleSceneDeleted(sceneId);
        return;
      }
      if (cloudSaveQueue.hasPending(sceneId)) {
        return;
      }
      const currentRevision = cloudSaveQueue.getRevision(sceneId) || 0;
      if (event.revision <= currentRevision) {
        return;
      }
      void loadSelectedCloudScene(sceneId, false).catch((error: any) => {
        if (error?.status === 401) {
          authSceneIdsRef.current.add(sceneId);
          setIsAuthOpen(true);
        } else {
          setErrorMessage(error?.message || "同步远端画板失败");
        }
      });
    });
  }, [
    cloudSaveQueue,
    currentSceneId,
    handleSceneDeleted,
    loadSelectedCloudScene,
  ]);

  useEffect(() => {
    if (
      typeof navigator !== "undefined" &&
      navigator.storage &&
      typeof navigator.storage.estimate === "function"
    ) {
      navigator.storage
        .estimate()
        .then((estimate) => {
          if (estimate.quota && estimate.usage) {
            const percentUsed = (estimate.usage / estimate.quota) * 100;
            if (percentUsed > 85) {
              console.warn(
                `[Storage] 浏览器存储空间使用率已达 ${percentUsed.toFixed(
                  1,
                )}%，建议通过云端 SQLite 管理并保存画板。`,
              );
            }
          }
        })
        .catch(() => {});
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Hoisted loadImages
  // ---------------------------------------------------------------------------
  const loadImages = useCallback(
    (data: ResolutionType<typeof initializeScene>, isInitialLoad = false) => {
      if (!data.scene || !excalidrawAPI || data.cloudScene) {
        return;
      }

      const fileIds: FileId[] = [];
      for (const element of data.scene.elements || []) {
        if (isInitializedImageElement(element)) {
          fileIds.push(element.fileId);
        }
      }

      if (isInitialLoad) {
        if (fileIds.length) {
          LocalData.fileStorage
            .getFiles(fileIds)
            .then(async ({ loadedFiles, erroredFiles }) => {
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
        // on fresh load, clear unused files from IDB (from previous
        // session)
        LocalData.fileStorage.clearObsoleteFiles({
          currentFileIds: fileIds,
        });
      }
    },
    [excalidrawAPI],
  );

  useEffect(() => {
    if (initialSceneInitializedRef.current) {
      return;
    }
    initialSceneInitializedRef.current = true;

    initializeScene(initialCloudScene)
      .then((data) => {
        initialSceneDataRef.current = data;
        initialStatePromiseRef.current.promise.resolve(data.scene);
      })
      .catch((error) => {
        console.error("Failed to initialize the local scene:", error);
        initialStatePromiseRef.current.promise.resolve(null);
      });
  }, [initialCloudScene]);

  useEffect(() => {
    if (
      !excalidrawAPI ||
      !initialSceneDataRef.current ||
      initialSceneImagesLoadedRef.current
    ) {
      return;
    }
    initialSceneImagesLoadedRef.current = true;
    loadImages(initialSceneDataRef.current, /* isInitialLoad */ true);
  }, [excalidrawAPI, loadImages]);

  const { onExport } = useEditorLifecycleSync({
    excalidrawAPI,
    currentSceneIdRef,
    cloudSaveQueue,
    setLangCode,
  });

  const onIncrement: ExcalidrawProps["onIncrement"] = useCallback((event) => {
    if (event.type === "durable") {
      cloudPersistenceDirtyRef.current = true;
      // Hydration uses CaptureUpdateAction.NEVER (ephemeral). Only a durable
      // local edit should cause the loaded remote scene to be saved again.
      if (cloudSceneLoadingRef.current) {
        cloudSceneLoadingRef.current.edited = true;
      }
    }
  }, []);

  const onChange = (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    const isCloudScene = Boolean(currentSceneIdRef.current);
    if (!LocalData.isSavePaused()) {
      LocalData.save(
        elements,
        appState,
        files,
        () => {
          if (excalidrawAPI) {
            let didChange = false;

            const elements = excalidrawAPI
              .getSceneElementsIncludingDeleted()
              .map((element) => {
                if (
                  LocalData.fileStorage.shouldUpdateImageElementStatus(element)
                ) {
                  const newElement = newElementWith(element, {
                    status: "saved",
                  });
                  if (newElement !== element) {
                    didChange = true;
                  }
                  return newElement;
                }
                return element;
              });

            if (didChange) {
              excalidrawAPI.updateScene({
                elements,
                captureUpdate: CaptureUpdateAction.NEVER,
              });
            }
          }
        },
        isCloudScene,
      );
    }

    const activeSceneId = currentSceneIdRef.current;
    if (
      activeSceneId &&
      !isApplyingCloudSceneRef.current &&
      cloudPersistenceDirtyRef.current
    ) {
      enqueueCloudSceneSnapshot(activeSceneId, elements, appState, files);
    }

    // Render the debug scene if the debug canvas is available
    if (debugCanvasRef.current && excalidrawAPI) {
      debugRenderer(
        debugCanvasRef.current,
        appState,
        elements,
        window.devicePixelRatio,
      );
    }
  };

  const renderCustomStats = (
    elements: readonly NonDeletedExcalidrawElement[],
    appState: UIAppState,
  ) => {
    return (
      <CustomStats
        setToast={(message) => excalidrawAPI!.setToast({ message })}
        appState={appState}
        elements={elements}
      />
    );
  };

  const localStorageQuotaExceeded = useAtomValue(localStorageQuotaExceededAtom);

  const navigateHomeAfterSave = useCallback(async () => {
    const sceneId = currentSceneIdRef.current;
    if (sceneId) {
      const saved = await saveCurrentCloudScene();
      if (!saved) {
        const persistError = cloudSaveQueue.getPersistenceError(sceneId);
        const shouldLeave = window.confirm(
          persistError
            ? "云端保存失败，且本地数据库写入也失败。已尝试保留会话恢复副本；离开仍可能丢失更改，仍要返回主页吗？"
            : "云端保存未完成。最新更改已暂存在本机，联网后会继续重试；仍要返回主页吗？",
        );
        if (!shouldLeave) {
          return;
        }
      }
    }
    if (onNavigateHome) {
      onNavigateHome();
      return;
    }
    window.location.assign(window.location.pathname);
  }, [cloudSaveQueue, onNavigateHome, saveCurrentCloudScene]);

  // browsers generally prevent infinite self-embedding, there are
  // cases where it still happens, and while we disallow self-embedding
  // by not whitelisting our own origin, this serves as an additional guard
  if (isSelfEmbedding) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          height: "100%",
        }}
      >
        <h1>I'm not a pretzel!</h1>
      </div>
    );
  }

  return (
    <div style={{ height: "100%" }} className="excalidraw-app">
      <Excalidraw
        onChange={onChange}
        onIncrement={onIncrement}
        onExport={onExport}
        initialData={initialStatePromiseRef.current.promise}
        UIOptions={{
          canvasActions: {
            toggleTheme: true,
          },
        }}
        langCode={langCode}
        renderCustomStats={renderCustomStats}
        detectScroll={false}
        handleKeyboardGlobally={true}
        autoFocus={true}
        aiEnabled={false}
        theme={editorTheme}
        onThemeChange={setAppTheme}
        renderTopRightUI={(isMobile) => (
          <EditorTopRightUI
            isMobile={isMobile}
            currentSceneId={currentSceneId}
            cloudSaveStatus={cloudSaveStatus}
            onSave={() => void saveCurrentCloudScene()}
            onOpenConflict={() => setIsCloudConflictDismissed(false)}
            onNavigateHome={() => void navigateHomeAfterSave()}
          />
        )}
        onLinkOpen={(element, event) => {
          if (element.link && isElementLink(element.link)) {
            event.preventDefault();
            excalidrawAPI?.setViewport({
              target: element.link,
              fit: "scale-down",
              animation: true,
            });
          }
        }}
      >
        <AppMainMenu
          theme={appTheme}
          refresh={() => forceRefresh((prev) => !prev)}
          onOpenCloudScenes={() => void navigateHomeAfterSave()}
        />
        <AppWelcomeScreen />
        <LazyOverwriteConfirmDialog />
        <Suspense fallback={null}>
          <LazyAuthDialog
            isOpen={isAuthOpen}
            onSuccess={() => {
              setIsAuthOpen(false);
              const authWaiters = authWaitersRef.current.splice(0);
              authWaiters.forEach((resolve) => resolve(true));
              const blockedSceneIds = [...authSceneIdsRef.current];
              authSceneIdsRef.current.clear();
              blockedSceneIds.forEach((sceneId) =>
                cloudSaveQueue.resumeAfterAuth(sceneId),
              );
              if (!authWaiters.length) {
                void bootstrapCloud();
              }
            }}
            onClose={() => {
              setIsAuthOpen(false);
              const authWaiters = authWaitersRef.current.splice(0);
              authWaiters.forEach((resolve) => resolve(false));
              const blockedSceneIds = [...authSceneIdsRef.current];
              authSceneIdsRef.current.clear();
              blockedSceneIds.forEach((sceneId) =>
                cloudSaveQueue.releaseAuthBlock(sceneId),
              );
            }}
          />
        </Suspense>
        {deletedRecoveries.length > 0 && !isAuthOpen && (
          <Suspense fallback={null}>
            <LazyCloudSceneDeletedDialog
              isOpen
              sceneName={deletedRecoveries[0]?.name || "未命名白板"}
              isRecovering={isRecoveringDeletedScene}
              onRecover={recoverDeletedScene}
              onDiscard={discardDeletedSceneRecovery}
            />
          </Suspense>
        )}
        <Suspense fallback={null}>
          <LazyCloudConflictDialog
            isOpen={
              cloudConflicts.length > 0 &&
              !isCloudConflictDismissed &&
              !isAuthOpen &&
              deletedRecoveries.length === 0
            }
            onDismiss={() => setIsCloudConflictDismissed(true)}
            onReload={() => resolveCloudConflict(false)}
            onOverwrite={() => resolveCloudConflict(true)}
          />
        </Suspense>
        <AppFooter onChange={() => excalidrawAPI?.refresh()} />
        {!currentSceneId && localStorageQuotaExceeded && (
          <div className="alert alert--danger">
            {t("alerts.localStorageQuotaExceeded")}
          </div>
        )}

        <AppSidebar />

        {cloudBootstrapError && (
          <ErrorDialog onClose={() => setCloudBootstrapError("")}>
            <div>{cloudBootstrapError}</div>
            <button
              type="button"
              onClick={() => {
                setCloudBootstrapError("");
                void bootstrapCloud();
              }}
            >
              重试
            </button>
          </ErrorDialog>
        )}
        {errorMessage && (
          <ErrorDialog onClose={() => setErrorMessage("")}>
            {errorMessage}
          </ErrorDialog>
        )}

        <EditorCommandPalette
          onNavigateHome={() => void navigateHomeAfterSave()}
        />
        {isVisualDebuggerEnabled() && excalidrawAPI && (
          <DebugCanvas
            appState={excalidrawAPI.getAppState()}
            scale={window.devicePixelRatio}
            ref={debugCanvasRef}
          />
        )}
      </Excalidraw>
    </div>
  );
};

export type EditorAppProps = {
  onNavigateHome?: () => void;
};

export const EditorApp = ({ onNavigateHome }: EditorAppProps) => (
  <ExcalidrawAPIProvider>
    <ExcalidrawWrapper onNavigateHome={onNavigateHome} />
  </ExcalidrawAPIProvider>
);

export default EditorApp;
