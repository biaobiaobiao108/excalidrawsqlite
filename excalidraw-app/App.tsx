import {
  Excalidraw,
  LiveCollaborationTrigger,
  TTDDialogTrigger,
  CaptureUpdateAction,
  reconcileElements,
  useEditorInterface,
  ExcalidrawAPIProvider,
  useExcalidrawAPI,
} from "@excalidraw/excalidraw";
import { trackEvent } from "@excalidraw/excalidraw/analytics";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import {
  CommandPalette,
  DEFAULT_CATEGORIES,
} from "@excalidraw/excalidraw/components/CommandPalette/CommandPalette";
import { ErrorDialog } from "@excalidraw/excalidraw/components/ErrorDialog";
import { OverwriteConfirmDialog } from "@excalidraw/excalidraw/components/OverwriteConfirm/OverwriteConfirm";
import { openConfirmModal } from "@excalidraw/excalidraw/components/OverwriteConfirm/OverwriteConfirmState";
import { ShareableLinkDialog } from "@excalidraw/excalidraw/components/ShareableLinkDialog";
import Trans from "@excalidraw/excalidraw/components/Trans";
import {
  APP_NAME,
  EVENT,
  VERSION_TIMEOUT,
  debounce,
  getVersion,
  getFrame,
  isTestEnv,
  preventUnload,
  resolvablePromise,
  isRunningInIframe,
  isDevEnv,
} from "@excalidraw/common";
import polyfill from "@excalidraw/excalidraw/polyfill";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadFromBlob } from "@excalidraw/excalidraw/data/blob";
import { t } from "@excalidraw/excalidraw/i18n";

import { usersIcon, share } from "@excalidraw/excalidraw/components/icons";
import { isElementLink } from "@excalidraw/element";
import {
  bumpElementVersions,
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import { newElementWith } from "@excalidraw/element";
import { isInitializedImageElement } from "@excalidraw/element";
import clsx from "clsx";
import {
  parseLibraryTokensFromUrl,
  useHandleLibrary,
} from "@excalidraw/excalidraw/data/library";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type { RestoredDataState } from "@excalidraw/excalidraw/data/restore";
import type {
  FileId,
  NonDeletedExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  ExcalidrawImperativeAPI,
  BinaryFiles,
  ExcalidrawInitialDataState,
  UIAppState,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import type { ResolutionType } from "@excalidraw/common/utility-types";
import type { ResolvablePromise } from "@excalidraw/common/utils";

import CustomStats from "./CustomStats";
import {
  Provider,
  useAtom,
  useAtomValue,
  useAtomWithInitialValue,
  appJotaiStore,
} from "./app-jotai";
import {
  FIREBASE_STORAGE_PREFIXES,
  STORAGE_KEYS,
  SYNC_BROWSER_TABS_TIMEOUT,
} from "./app_constants";
import Collab, {
  collabAPIAtom,
  isCollaboratingAtom,
  isOfflineAtom,
  userToFollowAtom,
} from "./collab/Collab";
import { AppFooter } from "./components/AppFooter";
import { AppMainMenu } from "./components/AppMainMenu";
import { AppWelcomeScreen } from "./components/AppWelcomeScreen";
import { CloudConflictDialog } from "./components/CloudConflictDialog";
import { CloudScenesDialog } from "./components/CloudScenesDialog";
import { AuthDialog } from "./components/AuthDialog";
import { TopErrorBoundary } from "./components/TopErrorBoundary";

import {
  exportToBackend,
  getCollaborationLinkData,
  importFromBackend,
  isCollaborationLink,
} from "./data";

import {
  checkAuthStatus,
  saveFilesToCloud,
  fetchCloudScene,
  fetchCloudFiles,
  fetchCloudScenes,
  createCloudScene,
} from "./data/cloudStorage";

import { updateStaleImageStatuses } from "./data/FileManager";
import { FileStatusStore } from "./data/fileStatusStore";
import {
  importFromLocalStorage,
  importUsernameFromLocalStorage,
} from "./data/localStorage";

import { loadFilesFromFirebase } from "./data/firebase";
import {
  LibraryIndexedDBAdapter,
  LibraryLocalStorageMigrationAdapter,
  LocalData,
  localStorageQuotaExceededAtom,
} from "./data/LocalData";
import { isBrowserStorageStateNewer } from "./data/tabSync";
import { ShareDialog, shareDialogStateAtom } from "./share/ShareDialog";
import CollabError, { collabErrorIndicatorAtom } from "./collab/CollabError";
import { useHandleAppTheme } from "./useHandleAppTheme";
import { getPreferredLanguage } from "./app-language/language-detector";
import { useAppLangCode } from "./app-language/language-state";
import DebugCanvas, {
  debugRenderer,
  isVisualDebuggerEnabled,
  loadSavedDebugState,
} from "./components/DebugCanvas";
import { useSimulatedCollaborators } from "./debugCollaborators";
import { AIComponents } from "./components/AI";

import { AppSidebar } from "./components/AppSidebar";
import {
  CloudSaveQueue,
  subscribeCloudTabSync,
  type CloudSaveStatus,
} from "./data/cloudSync";

import type { CloudSaveSnapshot } from "./data/cloudSync";

import type { CollabAPI } from "./collab/Collab";

polyfill();

window.EXCALIDRAW_THROTTLE_RENDER = true;

declare global {
  interface BeforeInstallPromptEventChoiceResult {
    outcome: "accepted" | "dismissed";
  }

  interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<BeforeInstallPromptEventChoiceResult>;
  }

  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }
}

let pwaEvent: BeforeInstallPromptEvent | null = null;

// Adding a listener outside of the component as it may (?) need to be
// subscribed early to catch the event.
//
// Also note that it will fire only if certain heuristics are met (user has
// used the app for some time, etc.)
window.addEventListener(
  "beforeinstallprompt",
  (event: BeforeInstallPromptEvent) => {
    // prevent Chrome <= 67 from automatically showing the prompt
    event.preventDefault();
    // cache for later use
    pwaEvent = event;
  },
);

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

const shareableLinkConfirmDialog = {
  title: t("overwriteConfirm.modal.shareableLink.title"),
  description: (
    <Trans
      i18nKey="overwriteConfirm.modal.shareableLink.description"
      bold={(text) => <strong>{text}</strong>}
      br={() => <br />}
    />
  ),
  actionLabel: t("overwriteConfirm.modal.shareableLink.button"),
  color: "danger",
} as const;

type InitializeSceneResult = {
  scene: ExcalidrawInitialDataState | null;
  isExternalScene: boolean;
  id?: string;
  key?: string;
  isCloudScene?: boolean;
  cloudRevision?: number;
};

const initializeScene = async (opts: {
  collabAPI: CollabAPI | null;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}): Promise<InitializeSceneResult> => {
  const searchParams = new URLSearchParams(window.location.search);
  const id = searchParams.get("id");
  const jsonBackendMatch = window.location.hash.match(
    /^#json=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/,
  );
  const externalUrlMatch = window.location.hash.match(/^#url=(.*)$/);

  const localDataState = importFromLocalStorage();

  let scene: Omit<
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

  let roomLinkData = getCollaborationLinkData(window.location.href);
  const isCloudSceneLink = Boolean(id && !jsonBackendMatch && !roomLinkData);
  const isExternalScene = !!(jsonBackendMatch || roomLinkData);
  if (isCloudSceneLink) {
    // Cloud scenes are loaded after the editor mounts so a slow or unavailable
    // API cannot keep Excalidraw's initialData promise pending forever.
    return { scene, isExternalScene: false };
  }
  if (isExternalScene) {
    if (
      // don't prompt if scene is empty
      !scene.elements.length ||
      // don't prompt for collab scenes because we don't override local storage
      roomLinkData ||
      // otherwise, prompt whether user wants to override current scene
      (await openConfirmModal(shareableLinkConfirmDialog))
    ) {
      if (jsonBackendMatch) {
        const imported = await importFromBackend(
          jsonBackendMatch[1],
          jsonBackendMatch[2],
        );

        scene = {
          elements: bumpElementVersions(
            restoreElements(imported.elements, null, {
              repairBindings: true,
              deleteInvisibleElements: true,
            }),
            localDataState?.elements,
          ),
          appState: restoreAppState(
            imported.appState,
            // local appState when importing from backend to ensure we restore
            // localStorage user settings which we do not persist on server.
            localDataState?.appState,
          ),
        };
      }
      scene.scrollToContent = true;
      if (!roomLinkData) {
        window.history.replaceState({}, APP_NAME, window.location.origin);
      }
    } else {
      // https://github.com/excalidraw/excalidraw/issues/1919
      if (document.hidden) {
        return new Promise((resolve, reject) => {
          window.addEventListener(
            "focus",
            () => initializeScene(opts).then(resolve).catch(reject),
            {
              once: true,
            },
          );
        });
      }

      roomLinkData = null;
      window.history.replaceState({}, APP_NAME, window.location.origin);
    }
  } else if (externalUrlMatch) {
    window.history.replaceState({}, APP_NAME, window.location.origin);

    const url = externalUrlMatch[1];
    try {
      const request = await fetch(window.decodeURIComponent(url));
      const data = await loadFromBlob(await request.blob(), null, null);
      if (
        !scene.elements.length ||
        (await openConfirmModal(shareableLinkConfirmDialog))
      ) {
        return { scene: data, isExternalScene };
      }
    } catch (error: any) {
      return {
        scene: {
          appState: {
            errorMessage: t("alerts.invalidSceneUrl"),
          },
        },
        isExternalScene,
      };
    }
  }

  if (roomLinkData && opts.collabAPI && opts.excalidrawAPI) {
    const { excalidrawAPI } = opts;

    const scene = await opts.collabAPI.startCollaboration(roomLinkData);

    return {
      // when collaborating, the state may have already been updated at this
      // point (we may have received updates from other clients), so reconcile
      // elements and appState with existing state
      scene: {
        ...scene,
        appState: {
          ...restoreAppState(
            {
              ...scene?.appState,
              theme: localDataState?.appState?.theme || scene?.appState?.theme,
            },
            excalidrawAPI.getAppState(),
          ),
          // necessary if we're invoking from a hashchange handler which doesn't
          // go through App.initializeScene() that resets this flag
          isLoading: false,
        },
        elements: reconcileElements(
          scene?.elements || [],
          excalidrawAPI.getSceneElementsIncludingDeleted() as RemoteExcalidrawElement[],
          excalidrawAPI.getAppState(),
        ),
      },
      isExternalScene: true,
      id: roomLinkData.roomId,
      key: roomLinkData.roomKey,
    };
  } else if (scene) {
    return isExternalScene && jsonBackendMatch
      ? {
          scene,
          isExternalScene,
          id: jsonBackendMatch[1],
          key: jsonBackendMatch[2],
        }
      : { scene, isExternalScene: false };
  }
  return { scene: null, isExternalScene: false };
};

const getCloudFileIds = (elements: readonly any[]) => {
  const fileIds = new Set<FileId>();
  for (const element of elements) {
    if (isInitializedImageElement(element)) {
      fileIds.add(element.fileId);
    }
  }
  return [...fileIds];
};

const ExcalidrawWrapper = () => {
  const excalidrawAPI = useExcalidrawAPI();

  const [errorMessage, setErrorMessage] = useState("");
  const isCollabDisabled = isRunningInIframe();

  const { editorTheme, appTheme, setAppTheme } = useHandleAppTheme();

  const [langCode, setLangCode] = useAppLangCode();

  const editorInterface = useEditorInterface();

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

  useEffect(() => {
    trackEvent("load", "frame", getFrame());
    // Delayed so that the app has a time to load the latest SW
    setTimeout(() => {
      trackEvent("load", "version", getVersion());
    }, VERSION_TIMEOUT);
  }, []);

  const [, setShareDialogState] = useAtom(shareDialogStateAtom);
  const [collabAPI] = useAtom(collabAPIAtom);
  const [isCollaborating] = useAtomWithInitialValue(isCollaboratingAtom, () => {
    return isCollaborationLink(window.location.href);
  });
  const collabError = useAtomValue(collabErrorIndicatorAtom);
  const userToFollow = useAtomValue(userToFollowAtom);

  const viewportStatusFrame = useMemo(
    () =>
      userToFollow
        ? {
            border: "var(--color-primary-hover)",
            label: {
              label: (
                <>
                  Following{" "}
                  <span
                    style={{
                      display: "block",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      maxWidth: 100,
                    }}
                    title={userToFollow.username}
                  >
                    {userToFollow.username}
                  </span>
                </>
              ),
              onClose: () => collabAPI?.setUserToFollow(null),
            },
          }
        : null,
    [userToFollow, collabAPI],
  );

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

  useSimulatedCollaborators(excalidrawAPI);

  // Cloud Whiteboard (SQLite) State & Handlers
  const [isCloudScenesOpen, setIsCloudScenesOpen] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [cloudBootstrapError, setCloudBootstrapError] = useState("");
  const [authSceneId, setAuthSceneId] = useState<string | null>(null);
  const [cloudConflict, setCloudConflict] = useState<{
    sceneId: string;
    snapshot: CloudSaveSnapshot;
  } | null>(null);
  const [currentSceneId, setCurrentSceneId] = useState<string | null>(null);
  const [cloudSaveStatus, setCloudSaveStatus] =
    useState<CloudSaveStatus>("idle");
  const currentSceneIdRef = useRef<string | null>(null);
  const isApplyingCloudSceneRef = useRef(false);
  const cloudBootstrapPromiseRef = useRef<Promise<void> | null>(null);
  const cloudSceneLoadIdRef = useRef(0);
  const authWaitersRef = useRef<Array<(authenticated: boolean) => void>>([]);
  const initialSceneDataRef = useRef<ResolutionType<
    typeof initializeScene
  > | null>(null);
  const initialSceneInitializedRef = useRef(false);
  const initialSceneImagesLoadedRef = useRef(false);
  const collaborationInitializedRef = useRef(false);

  const setActiveCloudScene = useCallback((sceneId: string | null) => {
    currentSceneIdRef.current = sceneId;
    setCurrentSceneId(sceneId);
  }, []);

  const requestCloudAuth = useCallback(() => {
    setIsAuthOpen(true);
    return new Promise<boolean>((resolve) => {
      authWaitersRef.current.push(resolve);
    });
  }, []);

  const cloudSaveQueue = useMemo(
    () =>
      new CloudSaveQueue({
        onAuthRequired: (sceneId) => {
          setIsAuthOpen(true);
          setAuthSceneId(sceneId);
          setActiveCloudScene(sceneId);
        },
        onConflict: (sceneId, snapshot) => {
          setCloudConflict({ sceneId, snapshot });
        },
        onError: (error) => {
          setCloudSaveStatus("error");
          setErrorMessage(`云端自动保存失败：${error.message}`);
        },
        onStatusChange: (sceneId, status) => {
          if (currentSceneIdRef.current === sceneId) {
            setCloudSaveStatus(status);
          }
        },
      }),
    [setActiveCloudScene],
  );

  useEffect(() => () => cloudSaveQueue.dispose(), [cloudSaveQueue]);

  const loadCloudFilesIntoScene = useCallback(
    async (
      elements: readonly any[],
      sceneId?: string,
      loadId = cloudSceneLoadIdRef.current,
    ) => {
      if (!excalidrawAPI) {
        return;
      }
      const fileIds = getCloudFileIds(elements);
      if (!fileIds.length) {
        return;
      }
      FileStatusStore.updateStatuses(
        fileIds.map((id) => [id, "loading"] as [FileId, "loading"]),
      );
      try {
        const { loadedFiles, erroredFiles } = await fetchCloudFiles(fileIds);
        if (
          (sceneId && currentSceneIdRef.current !== sceneId) ||
          loadId !== cloudSceneLoadIdRef.current
        ) {
          return;
        }
        excalidrawAPI.addFiles(loadedFiles);
        updateStaleImageStatuses({
          excalidrawAPI,
          erroredFiles,
          elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
        });
        FileStatusStore.updateStatuses([
          ...loadedFiles.map(
            (file) => [file.id, "loaded"] as [FileId, "loaded"],
          ),
          ...[...erroredFiles.keys()].map(
            (id) => [id, "error"] as [FileId, "error"],
          ),
        ]);
      } catch (error: any) {
        if (error?.status === 401) {
          setIsAuthOpen(true);
          setAuthSceneId(currentSceneIdRef.current);
        }
        FileStatusStore.updateStatuses(
          fileIds.map((id) => [id, "error"] as [FileId, "error"]),
        );
      }
    },
    [excalidrawAPI],
  );

  const loadSelectedCloudScene = useCallback(
    async (sceneId: string, updateUrl = true) => {
      const loadId = ++cloudSceneLoadIdRef.current;
      const cloudData = await fetchCloudScene(sceneId);
      if (!excalidrawAPI) {
        throw new Error("编辑器尚未初始化");
      }

      const elements = restoreElements(cloudData.elements, null, {
        repairBindings: true,
        deleteInvisibleElements: true,
      });

      cloudSaveQueue.setRevision(sceneId, cloudData.revision);
      setCloudBootstrapError("");
      if (updateUrl) {
        window.history.replaceState(
          {},
          "",
          `${window.location.pathname}?id=${encodeURIComponent(sceneId)}`,
        );
      }

      isApplyingCloudSceneRef.current = true;
      try {
        excalidrawAPI.updateScene({
          elements,
          appState: restoreAppState(
            { ...cloudData.appState, name: cloudData.name },
            excalidrawAPI.getAppState(),
          ),
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        void loadCloudFilesIntoScene(elements, sceneId, loadId);
        if (cloudData.elements.length) {
          setTimeout(() => {
            if (!excalidrawAPI.isDestroyed) {
              excalidrawAPI.setViewport({
                target: cloudData.elements,
                fit: "scale-down",
                animation: true,
              });
            }
          }, 50);
        }
      } finally {
        isApplyingCloudSceneRef.current = false;
      }
      // Do not mark the scene active until the remote snapshot has replaced
      // the editor state. Initialization onChange events must never enqueue
      // the local browser cache back to the cloud scene.
      setActiveCloudScene(sceneId);
      return cloudData;
    },
    [
      cloudSaveQueue,
      excalidrawAPI,
      loadCloudFilesIntoScene,
      setActiveCloudScene,
    ],
  );

  const handleSelectScene = useCallback(
    async (sceneId: string): Promise<boolean> => {
      try {
        await loadSelectedCloudScene(sceneId);
        return true;
      } catch (error: any) {
        if (error?.status === 401) {
          setIsAuthOpen(true);
        } else {
          setErrorMessage(error?.message || "打开云端画板失败");
        }
        return false;
      }
    },
    [loadSelectedCloudScene],
  );

  const bootstrapCloud = useCallback(() => {
    if (cloudBootstrapPromiseRef.current) {
      return cloudBootstrapPromiseRef.current;
    }

    const run = (async () => {
      if (isCollaborationLink(window.location.href)) {
        return;
      }
      if (!excalidrawAPI) {
        return;
      }

      setCloudBootstrapError("");
      const status = await checkAuthStatus();
      if (status.authRequired && !status.authenticated) {
        setIsAuthOpen(true);
        return;
      }

      const requestedId = new URLSearchParams(window.location.search).get("id");
      if (requestedId) {
        try {
          await loadSelectedCloudScene(requestedId, false);
          return;
        } catch (error: any) {
          if (error?.status !== 400 && error?.status !== 404) {
            throw error;
          }
          window.history.replaceState({}, "", window.location.pathname);
        }
      }

      const scenes = await fetchCloudScenes();
      let scene = scenes[0];
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
      await loadSelectedCloudScene(scene.id, true);
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
  }, [excalidrawAPI, loadSelectedCloudScene]);

  useEffect(() => {
    if (!excalidrawAPI || (!isCollabDisabled && !collabAPI)) {
      return;
    }
    void bootstrapCloud();
  }, [bootstrapCloud, collabAPI, excalidrawAPI, isCollabDisabled]);

  const resolveCloudConflict = useCallback(
    async (keepLocal: boolean) => {
      if (!cloudConflict) {
        return;
      }
      try {
        const remote = await fetchCloudScene(cloudConflict.sceneId);
        cloudSaveQueue.resolveConflict(
          cloudConflict.sceneId,
          remote.revision,
          keepLocal,
        );
        if (!keepLocal) {
          await loadSelectedCloudScene(cloudConflict.sceneId, false);
        }
        setCloudConflict(null);
      } catch (error: any) {
        if (error?.status === 401) {
          setIsAuthOpen(true);
        } else {
          setErrorMessage(error?.message || "处理云端冲突失败");
        }
      }
    },
    [cloudConflict, cloudSaveQueue, loadSelectedCloudScene],
  );

  const handleSceneDeleted = useCallback(
    async (sceneId: string) => {
      cloudSaveQueue.cancel(sceneId);
      if (currentSceneId !== sceneId) {
        return;
      }
      setActiveCloudScene(null);
      window.history.replaceState({}, "", window.location.pathname);
      try {
        const scenes = await fetchCloudScenes();
        const nextScene =
          scenes[0] || (await createCloudScene({ name: "我的画板" }));
        await loadSelectedCloudScene(nextScene.id);
      } catch (error: any) {
        if (error?.status === 401) {
          setIsAuthOpen(true);
        } else {
          setErrorMessage(error?.message || "删除画板后切换失败");
        }
      }
    },
    [
      cloudSaveQueue,
      currentSceneId,
      loadSelectedCloudScene,
      setActiveCloudScene,
    ],
  );

  useEffect(() => {
    return subscribeCloudTabSync((message) => {
      if (message.type === "scene_saved") {
        cloudSaveQueue.setRevision(message.sceneId, message.revision);
        if (
          currentSceneIdRef.current === message.sceneId &&
          !cloudSaveQueue.hasPending(message.sceneId)
        ) {
          void loadSelectedCloudScene(message.sceneId, false);
        }
      } else if (message.type === "scene_renamed") {
        cloudSaveQueue.setRevision(message.sceneId, message.revision);
        if (
          currentSceneIdRef.current === message.sceneId &&
          excalidrawAPI &&
          !cloudSaveQueue.hasPending(message.sceneId)
        ) {
          excalidrawAPI.updateScene({
            appState: { name: message.name },
            captureUpdate: CaptureUpdateAction.NEVER,
          });
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
      if (!data.scene || !excalidrawAPI) {
        return;
      }

      if (collabAPI?.isCollaborating()) {
        if (data.scene.elements) {
          collabAPI
            .fetchImageFilesFromFirebase({
              elements: data.scene.elements,
              forceFetchFiles: true,
            })
            .then(({ loadedFiles, erroredFiles }) => {
              excalidrawAPI.addFiles(loadedFiles);
              updateStaleImageStatuses({
                excalidrawAPI,
                erroredFiles,
                elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
              });
            });
        }
      } else {
        const fileIds =
          data.scene.elements?.reduce((acc, element) => {
            if (isInitializedImageElement(element)) {
              return acc.concat(element.fileId);
            }
            return acc;
          }, [] as FileId[]) || [];

        if (data.isCloudScene) {
          void loadCloudFilesIntoScene(data.scene.elements || []);
        } else if (data.isExternalScene && data.id && data.key) {
          if (fileIds.length) {
            // Direct Firebase call (not through FileManager), so track manually
            FileStatusStore.updateStatuses(
              fileIds.map((id) => [id, "loading"]),
            );
          }
          loadFilesFromFirebase(
            `${FIREBASE_STORAGE_PREFIXES.shareLinkFiles}/${data.id}`,
            data.key,
            fileIds,
          ).then(({ loadedFiles, erroredFiles }) => {
            excalidrawAPI.addFiles(loadedFiles);
            updateStaleImageStatuses({
              excalidrawAPI,
              erroredFiles,
              elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
            });
            FileStatusStore.updateStatuses([
              ...loadedFiles.map((f) => [f.id, "loaded"] as [FileId, "loaded"]),
              ...[...erroredFiles.keys()].map(
                (id) => [id, "error"] as [FileId, "error"],
              ),
            ]);
          });
        } else if (isInitialLoad) {
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
      }
    },
    [collabAPI, excalidrawAPI, loadCloudFilesIntoScene],
  );

  useEffect(() => {
    if (initialSceneInitializedRef.current) {
      return;
    }
    initialSceneInitializedRef.current = true;

    initializeScene({ collabAPI: null, excalidrawAPI: null })
      .then((data) => {
        initialSceneDataRef.current = data;
        initialStatePromiseRef.current.promise.resolve(data.scene);
      })
      .catch((error) => {
        console.error("Failed to initialize the local scene:", error);
        initialStatePromiseRef.current.promise.resolve(null);
      });
  }, []);

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

  useEffect(() => {
    if (
      !excalidrawAPI ||
      !collabAPI ||
      !isCollaborationLink(window.location.href) ||
      collaborationInitializedRef.current
    ) {
      return;
    }
    collaborationInitializedRef.current = true;
    initializeScene({ collabAPI, excalidrawAPI })
      .then((data) => {
        if (excalidrawAPI.isDestroyed || !data.scene) {
          return;
        }
        loadImages(data);
        excalidrawAPI.updateScene({
          elements: restoreElements(data.scene.elements, null, {
            repairBindings: true,
          }),
          appState: restoreAppState(data.scene.appState, null),
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      })
      .catch((error: any) => {
        console.error("Failed to initialize the collaboration scene:", error);
        if (!excalidrawAPI.isDestroyed) {
          excalidrawAPI.updateScene({
            appState: {
              isLoading: false,
              errorMessage: error?.message || "无法加载协作场景",
            },
          });
        }
      });
  }, [collabAPI, excalidrawAPI, loadImages]);

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }

    const onHashChange = async (event: HashChangeEvent) => {
      event.preventDefault();
      const libraryUrlTokens = parseLibraryTokensFromUrl();
      if (!libraryUrlTokens) {
        if (
          collabAPI?.isCollaborating() &&
          !isCollaborationLink(window.location.href)
        ) {
          collabAPI.stopCollaboration(false);
        }
        excalidrawAPI.updateScene({ appState: { isLoading: true } });

        initializeScene({ collabAPI, excalidrawAPI })
          .then((data) => {
            loadImages(data);
            if (data.scene) {
              excalidrawAPI.updateScene({
                elements: restoreElements(data.scene.elements, null, {
                  repairBindings: true,
                }),
                appState: restoreAppState(data.scene.appState, null),
                captureUpdate: CaptureUpdateAction.IMMEDIATELY,
              });
            }
          })
          .catch((error: any) => {
            console.error("Failed to initialize the linked scene:", error);
            excalidrawAPI.updateScene({
              appState: {
                isLoading: false,
                errorMessage: error?.message || "无法加载场景",
              },
            });
          });
      }
    };

    const syncData = debounce(() => {
      if (isTestEnv()) {
        return;
      }
      if (
        !document.hidden &&
        ((collabAPI && !collabAPI.isCollaborating()) || isCollabDisabled)
      ) {
        // don't sync if local state is newer or identical to browser state
        if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_DATA_STATE)) {
          const localDataState = importFromLocalStorage();
          const username = importUsernameFromLocalStorage();
          setLangCode(getPreferredLanguage());
          excalidrawAPI.updateScene({
            ...localDataState,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
          LibraryIndexedDBAdapter.load().then((data) => {
            if (data) {
              excalidrawAPI.updateLibrary({
                libraryItems: data.libraryItems,
              });
            }
          });
          collabAPI?.setUsername(username || "");
        }

        if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_FILES)) {
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

    window.addEventListener(EVENT.HASHCHANGE, onHashChange, false);
    window.addEventListener(EVENT.UNLOAD, onUnload, false);
    window.addEventListener("pagehide", onUnload, false);
    window.addEventListener(EVENT.BLUR, visibilityChange, false);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, visibilityChange, false);
    window.addEventListener(EVENT.FOCUS, visibilityChange, false);
    return () => {
      window.removeEventListener(EVENT.HASHCHANGE, onHashChange, false);
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
  }, [
    isCollabDisabled,
    collabAPI,
    excalidrawAPI,
    setLangCode,
    loadImages,
    cloudSaveQueue,
  ]);

  useEffect(() => {
    const unloadHandler = (event: BeforeUnloadEvent) => {
      LocalData.flushSave();
      const sceneId = currentSceneIdRef.current;
      if (sceneId) {
        void cloudSaveQueue.flush(sceneId);
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
  }, [excalidrawAPI, cloudSaveQueue]);

  const onChange = (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    if (collabAPI?.isCollaborating()) {
      collabAPI.syncElements(elements);
    }

    // this check is redundant, but since this is a hot path, it's best
    // not to evaludate the nested expression every time
    if (!LocalData.isSavePaused()) {
      LocalData.save(elements, appState, files, () => {
        if (excalidrawAPI) {
          let didChange = false;

          const elements = excalidrawAPI
            .getSceneElementsIncludingDeleted()
            .map((element) => {
              if (
                LocalData.fileStorage.shouldUpdateImageElementStatus(element)
              ) {
                const newElement = newElementWith(element, { status: "saved" });
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
      });
    }

    const activeSceneId = currentSceneIdRef.current;
    if (
      activeSceneId &&
      !isApplyingCloudSceneRef.current &&
      !isCollaborationLink(window.location.href)
    ) {
      const referencedFiles: BinaryFiles = {};
      for (const fileId of getCloudFileIds(elements)) {
        const file = files[fileId];
        if (file) {
          referencedFiles[fileId] = file;
        }
      }
      cloudSaveQueue.enqueue({
        sceneId: activeSceneId,
        name: excalidrawAPI?.getName() || "未命名白板",
        elements,
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor,
          gridSize: appState.gridSize,
        },
        files: referencedFiles,
      });
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

  const [latestShareableLink, setLatestShareableLink] = useState<string | null>(
    null,
  );

  const onExportToBackend = async (
    exportedElements: readonly NonDeletedExcalidrawElement[],
    appState: Partial<AppState>,
    files: BinaryFiles,
  ) => {
    if (exportedElements.length === 0) {
      throw new Error(t("alerts.cannotExportEmptyCanvas"));
    }
    try {
      const { url, errorMessage } = await exportToBackend(
        exportedElements,
        {
          ...appState,
          viewBackgroundColor: appState.exportBackground
            ? appState.viewBackgroundColor
            : getDefaultAppState().viewBackgroundColor,
        },
        files,
      );

      if (errorMessage) {
        throw new Error(errorMessage);
      }

      if (url) {
        setLatestShareableLink(url);
      }
    } catch (error: any) {
      if (error.name !== "AbortError") {
        const { width, height } = appState;
        console.error(error, {
          width,
          height,
          devicePixelRatio: window.devicePixelRatio,
        });
        throw new Error(error.message);
      }
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

  const isOffline = useAtomValue(isOfflineAtom);

  const localStorageQuotaExceeded = useAtomValue(localStorageQuotaExceededAtom);

  const onCollabDialogOpen = useCallback(
    () => setShareDialogState({ isOpen: true, type: "collaborationOnly" }),
    [setShareDialogState],
  );

  // ---------------------------------------------------------------------------
  // onExport — intercepts file save to wait for pending image loads
  // ---------------------------------------------------------------------------
  const onExport: Required<ExcalidrawProps>["onExport"] = useCallback(
    async function* () {
      let snapshot = FileStatusStore.getSnapshot();
      const { pending, total } = FileStatusStore.getPendingCount(
        snapshot.value,
      );
      if (pending === 0) {
        return;
      }

      // Yield initial progress
      yield {
        type: "progress",
        progress: (total - pending) / total,
        message: `Loading images (${total - pending}/${total})...`,
      };

      // Wait for all pending images to finish
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

  // const onExport = () => {
  //   return new Promise((r) => setTimeout(r, 2500));
  //   // console.log("onExport");
  // };

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
    <div
      style={{ height: "100%" }}
      className={clsx("excalidraw-app", {
        "is-collaborating": isCollaborating,
      })}
    >
      <Excalidraw
        viewportStatusFrame={viewportStatusFrame}
        userToFollow={userToFollow}
        onChange={onChange}
        onExport={onExport}
        initialData={initialStatePromiseRef.current.promise}
        isCollaborating={isCollaborating}
        onPointerUpdate={collabAPI?.onPointerUpdate}
        UIOptions={{
          canvasActions: {
            toggleTheme: true,
            export: {
              onExportToBackend,
            },
          },
        }}
        langCode={langCode}
        renderCustomStats={renderCustomStats}
        detectScroll={false}
        handleKeyboardGlobally={true}
        autoFocus={true}
        theme={editorTheme}
        onThemeChange={setAppTheme}
        renderTopRightUI={(isMobile) => {
          return (
            <div className="excalidraw-ui-top-right">
              <button
                type="button"
                className="cloud-scenes-top-btn"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  background: "var(--color-surface-low, #ececf4)",
                  border: "1px solid var(--default-border-color, #dcdce6)",
                  borderRadius: "8px",
                  padding: "6px 12px",
                  fontSize: "0.85rem",
                  fontWeight: 500,
                  cursor: "pointer",
                  color: "var(--text-color-primary, #333)",
                  height: "36px",
                }}
                onClick={() => setIsCloudScenesOpen(true)}
                title="管理我的云端画板 (SQLite 持久化)"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  stroke="currentColor"
                  strokeWidth="2"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                </svg>
                我的画板
              </button>

              {!isMobile && collabAPI && !isCollabDisabled && (
                <>
                  {collabError.message && (
                    <CollabError collabError={collabError} />
                  )}
                  <LiveCollaborationTrigger
                    isCollaborating={isCollaborating}
                    onSelect={() =>
                      setShareDialogState({ isOpen: true, type: "share" })
                    }
                    editorInterface={editorInterface}
                  />
                </>
              )}
            </div>
          );
        }}
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
          onCollabDialogOpen={onCollabDialogOpen}
          isCollaborating={isCollaborating}
          isCollabEnabled={!isCollabDisabled}
          theme={appTheme}
          refresh={() => forceRefresh((prev) => !prev)}
          onOpenCloudScenes={() => setIsCloudScenesOpen(true)}
        />
        <AppWelcomeScreen
          onCollabDialogOpen={onCollabDialogOpen}
          isCollabEnabled={!isCollabDisabled}
        />
        <OverwriteConfirmDialog>
          <OverwriteConfirmDialog.Actions.ExportToImage />
          <OverwriteConfirmDialog.Actions.SaveToDisk />
        </OverwriteConfirmDialog>
        <CloudScenesDialog
          isOpen={isCloudScenesOpen}
          currentSceneId={currentSceneId}
          onClose={() => setIsCloudScenesOpen(false)}
          onSelectScene={handleSelectScene}
          onAuthRequired={requestCloudAuth}
          onSceneDeleted={handleSceneDeleted}
        />
        <AuthDialog
          isOpen={isAuthOpen}
          onSuccess={() => {
            setIsAuthOpen(false);
            const authWaiters = authWaitersRef.current.splice(0);
            authWaiters.forEach((resolve) => resolve(true));
            if (authSceneId) {
              cloudSaveQueue.resumeAfterAuth(authSceneId);
              setAuthSceneId(null);
            }
            if (!authWaiters.length) {
              void bootstrapCloud();
            }
          }}
          onClose={() => {
            setIsAuthOpen(false);
            const authWaiters = authWaitersRef.current.splice(0);
            authWaiters.forEach((resolve) => resolve(false));
            setAuthSceneId(null);
          }}
        />
        <CloudConflictDialog
          isOpen={!!cloudConflict}
          onReload={() => resolveCloudConflict(false)}
          onOverwrite={() => resolveCloudConflict(true)}
        />
        <AppFooter onChange={() => excalidrawAPI?.refresh()} />
        {excalidrawAPI && <AIComponents excalidrawAPI={excalidrawAPI} />}

        <TTDDialogTrigger />
        {isCollaborating && isOffline && (
          <div className="alertalert--warning">
            {t("alerts.collabOfflineWarning")}
          </div>
        )}
        {localStorageQuotaExceeded && (
          <div className="alert alert--danger">
            {t("alerts.localStorageQuotaExceeded")}
          </div>
        )}
        {latestShareableLink && (
          <ShareableLinkDialog
            link={latestShareableLink}
            onCloseRequest={() => setLatestShareableLink(null)}
            setErrorMessage={setErrorMessage}
          />
        )}
        {excalidrawAPI && !isCollabDisabled && (
          <Collab excalidrawAPI={excalidrawAPI} />
        )}

        <ShareDialog
          collabAPI={collabAPI}
          onExportToBackend={async () => {
            if (excalidrawAPI) {
              try {
                await onExportToBackend(
                  excalidrawAPI.getSceneElements(),
                  excalidrawAPI.getAppState(),
                  excalidrawAPI.getFiles(),
                );
              } catch (error: any) {
                setErrorMessage(error.message);
              }
            }
          }}
        />

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
        {currentSceneId && cloudSaveStatus !== "idle" && (
          <div
            className="alert alert--warning"
            role="status"
            style={{
              alignItems: "center",
              bottom: "1rem",
              display: "flex",
              gap: "0.5rem",
              left: "50%",
              position: "fixed",
              transform: "translateX(-50%)",
              zIndex: 10,
            }}
          >
            <span>
              {cloudSaveStatus === "saving" && "云端保存中..."}
              {cloudSaveStatus === "saved" && "已保存到云端"}
              {cloudSaveStatus === "error" && "云端保存失败，数据仍在本地待重试"}
              {cloudSaveStatus === "auth" && "需要重新认证后才能保存"}
              {cloudSaveStatus === "conflict" && "云端版本冲突，等待处理"}
            </span>
            {cloudSaveStatus === "error" && (
              <button
                className="excalidraw-button"
                type="button"
                onClick={() => void cloudSaveQueue.flush(currentSceneId)}
              >
                重试保存
              </button>
            )}
          </div>
        )}
        {errorMessage && (
          <ErrorDialog onClose={() => setErrorMessage("")}>
            {errorMessage}
          </ErrorDialog>
        )}

        <CommandPalette
          customCommandPaletteItems={[
            {
              label: t("labels.liveCollaboration"),
              category: DEFAULT_CATEGORIES.app,
              keywords: [
                "team",
                "multiplayer",
                "share",
                "public",
                "session",
                "invite",
              ],
              icon: usersIcon,
              perform: () => {
                setShareDialogState({
                  isOpen: true,
                  type: "collaborationOnly",
                });
              },
            },
            {
              label: t("roomDialog.button_stopSession"),
              category: DEFAULT_CATEGORIES.app,
              predicate: () => !!collabAPI?.isCollaborating(),
              keywords: [
                "stop",
                "session",
                "end",
                "leave",
                "close",
                "exit",
                "collaboration",
              ],
              perform: () => {
                if (collabAPI) {
                  collabAPI.stopCollaboration();
                  if (!collabAPI.isCollaborating()) {
                    setShareDialogState({ isOpen: false });
                  }
                }
              },
            },
            {
              label: t("labels.share"),
              category: DEFAULT_CATEGORIES.app,
              predicate: true,
              icon: share,
              keywords: [
                "link",
                "shareable",
                "readonly",
                "export",
                "publish",
                "snapshot",
                "url",
                "collaborate",
                "invite",
              ],
              perform: async () => {
                setShareDialogState({ isOpen: true, type: "share" });
              },
            },
            {
              label: "云端画板管理 (SQLite)",
              category: DEFAULT_CATEGORIES.app,
              predicate: true,
              keywords: [
                "cloud",
                "scene",
                "board",
                "sqlite",
                "save",
                "load",
                "画板",
                "云端",
              ],
              perform: () => {
                setIsCloudScenesOpen(true);
              },
            },
            {
              label: t("labels.installPWA"),
              category: DEFAULT_CATEGORIES.app,
              predicate: () => !!pwaEvent,
              perform: () => {
                if (pwaEvent) {
                  pwaEvent.prompt();
                  pwaEvent.userChoice.then(() => {
                    // event cannot be reused, but we'll hopefully
                    // grab new one as the event should be fired again
                    pwaEvent = null;
                  });
                }
              },
            },
          ]}
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

const ExcalidrawApp = () => {
  return (
    <TopErrorBoundary>
      <Provider store={appJotaiStore}>
        <ExcalidrawAPIProvider>
          <ExcalidrawWrapper />
        </ExcalidrawAPIProvider>
      </Provider>
    </TopErrorBoundary>
  );
};

export default ExcalidrawApp;
