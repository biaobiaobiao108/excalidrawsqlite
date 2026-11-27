import type {
  ExcalidrawElement,
  FileId,
  NonDeletedExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import { createStore, get, promisifyRequest } from "idb-keyval";

import {
  CloudApiError,
  fetchCloudScene,
  saveCloudScene,
  saveFilesToCloud,
} from "./cloudStorage";
import type { CloudSceneData } from "./cloudStorage";

export interface CloudSaveSnapshot {
  sceneId: string;
  name: string;
  elements: readonly OrderedExcalidrawElement[];
  appState: Pick<AppState, "viewBackgroundColor" | "gridSize">;
  files: BinaryFiles;
  /** Revision observed when this snapshot was created. */
  baseRevision?: number;
  /** Identifies the persisted edit across editor instances and browser tabs. */
  persistenceId?: string;
  draftOwner?: string;
  draftUpdatedAt?: number;
}

export const remapSceneFileIds = <Element extends ExcalidrawElement>(
  elements: readonly Element[],
  replacements: Map<FileId, FileId> | void,
): readonly Element[] =>
  replacements?.size
    ? elements.map((element) => {
        const fileId =
          element.type === "image" && element.fileId
            ? replacements.get(element.fileId)
            : undefined;
        return fileId ? { ...element, fileId } : element;
      })
    : elements;

const remapCloudSnapshotFiles = (
  snapshot: CloudSaveSnapshot,
  replacements: Map<FileId, FileId>,
): CloudSaveSnapshot => ({
  ...snapshot,
  elements: remapSceneFileIds(snapshot.elements, replacements),
  files: Object.fromEntries(
    Object.values(snapshot.files).map((file) => {
      const id = replacements.get(file.id) ?? file.id;
      return [id, { ...file, id }];
    }),
  ),
});

export const getCloudSceneRecoveryData = (
  remote: CloudSceneData,
  snapshot?: CloudSaveSnapshot | null,
): CloudSceneData =>
  snapshot?.sceneId === remote.id
    ? {
        ...remote,
        name: snapshot.name,
        elements: snapshot.elements,
        appState: snapshot.appState,
      }
    : remote;

export type CloudScenePersistenceSignatureInput = {
  name: string;
  elements: readonly any[];
  appState: Pick<AppState, "viewBackgroundColor" | "gridSize">;
  files: BinaryFiles;
};

export const getCloudPersistenceSignature = (
  name: string,
  elements: readonly any[],
  appState: Pick<AppState, "viewBackgroundColor" | "gridSize">,
  files: BinaryFiles,
  fileIds = elements
    .filter(
      (element) =>
        element?.type === "image" &&
        element.isDeleted !== true &&
        typeof element.fileId === "string",
    )
    .map((element) => element.fileId as FileId),
) =>
  JSON.stringify({
    name,
    // Excalidraw increments version/versionNonce for every persisted element
    // change. Avoid serializing full element geometry and image data URLs on
    // every pointer move; the autosave queue only needs a change fingerprint.
    elements: elements.map((element) => [
      element.id,
      element.version,
      element.versionNonce,
      element.isDeleted,
    ]),
    appState,
    files: fileIds.map((fileId: FileId) => {
      const file = files[fileId];
      return [
        fileId,
        file?.mimeType,
        file?.created,
        file?.version,
        file?.dataURL?.length,
      ];
    }),
  });

export const getCloudSceneLoadSignatures = (
  remoteScene: CloudScenePersistenceSignatureInput,
  currentScene: CloudScenePersistenceSignatureInput,
  editedDuringLoad = true,
) => {
  const remoteSignature = getCloudPersistenceSignature(
    remoteScene.name,
    remoteScene.elements,
    remoteScene.appState,
    remoteScene.files,
  );
  const currentSignature = getCloudPersistenceSignature(
    currentScene.name,
    currentScene.elements,
    currentScene.appState,
    currentScene.files,
  );
  // Restore/attachment hydration can normalize the scene without a user edit.
  // Adopt the hydrated scene as the baseline instead of writing those changes
  // back and invalidating the revision held by an MCP client.
  const baselineSignature = editedDuringLoad
    ? remoteSignature
    : currentSignature;
  return {
    baselineSignature,
    currentSignature,
    hasChanges: baselineSignature !== currentSignature,
  };
};

type QueueCallbacks = {
  onAuthRequired: (sceneId: string) => void;
  onConflict: (sceneId: string, snapshot: CloudSaveSnapshot) => void;
  onSceneUnavailable?: (sceneId: string, snapshot: CloudSaveSnapshot) => void;
  onError: (error: Error) => void;
  onStatusChange?: (sceneId: string, status: CloudSaveStatus) => void;
  /** Receives only snapshots confirmed by the server, with their committed revision. */
  onSnapshotSaved?: (snapshot: CloudSaveSnapshot, revision: number) => void;
};

export type CloudSaveStatus =
  "idle" | "pending" | "saving" | "saved" | "error" | "auth" | "conflict";

type BlockReason = "auth" | "conflict" | "deleted";

type CloudSaveDependencies = {
  fetchCloudScene: typeof fetchCloudScene;
  saveCloudScene: typeof saveCloudScene;
  saveFilesToCloud: typeof saveFilesToCloud;
  persistence: CloudSavePersistence;
};

type CloudSavePersistenceOperation = {
  generation: number;
  snapshot: CloudSaveSnapshot | null;
  expectedSnapshot?: CloudSaveSnapshot;
};

type CloudSavePersistenceWriter = {
  desired: CloudSavePersistenceOperation | null;
  running: boolean;
  promise: Promise<void>;
};

export type CloudDraftSummary = {
  key: string;
  name: string;
  persistenceId?: string;
  updatedAt?: number;
  elementCount?: number;
};

export type CloudSavePersistence = {
  list: () => Promise<CloudDraftSummary[]>;
  load: (key: string) => Promise<CloudSaveSnapshot | undefined>;
  save: (snapshot: CloudSaveSnapshot) => Promise<void>;
  remove: (
    sceneId: string,
    expectedSnapshot?: CloudSaveSnapshot,
  ) => Promise<void>;
};

// Compare legacy snapshots without allocating serialized elements or data URLs.
const snapshotValuesMatch = (left: unknown, right: unknown): boolean => {
  if (left === right) {
    return true;
  }
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => snapshotValuesMatch(value, right[index]))
    );
  }
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        snapshotValuesMatch(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
};

export const matchesPersistedCloudSnapshot = (
  current: CloudSaveSnapshot | undefined,
  expected: CloudSaveSnapshot,
) =>
  Boolean(
    current &&
    (expected.persistenceId
      ? current.persistenceId === expected.persistenceId
      : !current.persistenceId && snapshotValuesMatch(current, expected)),
  );

const cloudSaveStore = createStore("cloud-save-db", "pending-scenes");
// Use a separate key for each document editing this board. Existing records
// keyed by a plain board ID can still be recovered.
const getDraftKey = (sceneId: string, draftOwner?: string) =>
  draftOwner ? `${sceneId}:${draftOwner}` : sceneId;

const getSnapshotKey = (snapshot: CloudSaveSnapshot) =>
  getDraftKey(snapshot.sceneId, snapshot.draftOwner);

const describeDraft = (snapshot: CloudSaveSnapshot): CloudDraftSummary => ({
  key: getSnapshotKey(snapshot),
  name: snapshot.name,
  persistenceId: snapshot.persistenceId,
  updatedAt: snapshot.draftUpdatedAt,
  elementCount: snapshot.elements.length,
});

const DRAFT_SUMMARY_PREFIX = ":summary:";
const getDraftSceneId = (key: string) => key.split(":", 1)[0];
const getDraftLockName = (key: string) => `excalidraw-draft:${key}`;

const getDraftLocks = () => globalThis.navigator?.locks;
export const canDiscardOtherCloudDrafts = () => Boolean(getDraftLocks());
const heldDraftLocks = new Map<string, Promise<boolean>>();

const holdDraftLock = (key: string) => {
  const locks = getDraftLocks();
  if (!locks) return Promise.resolve(false);
  const name = getDraftLockName(key);
  const held = heldDraftLocks.get(name);
  if (held) return held;
  const acquired = new Promise<boolean>((resolve, reject) => {
    void locks
      .request(name, { ifAvailable: true }, (lock) => {
        resolve(Boolean(lock));
        // Keep ownership across editor mounts. The browser releases it when
        // this document closes or crashes, including suspended background tabs.
        if (lock) return new Promise<void>(() => {});
      })
      .catch(reject);
  });
  heldDraftLocks.set(name, acquired);
  const forget = () => heldDraftLocks.delete(name);
  void acquired.then((locked) => {
    if (!locked) forget();
  }, forget);
  return acquired;
};

const memoryPendingSnapshots = new Map<string, CloudSaveSnapshot>();
const memoryCloudSavePersistence: CloudSavePersistence = {
  list: async () => [...memoryPendingSnapshots.values()].map(describeDraft),
  load: async (key) => memoryPendingSnapshots.get(key),
  save: async (snapshot) => {
    memoryPendingSnapshots.set(getSnapshotKey(snapshot), snapshot);
  },
  remove: async (sceneId, expectedSnapshot) => {
    const key = getDraftKey(sceneId, expectedSnapshot?.draftOwner);
    if (
      !expectedSnapshot ||
      matchesPersistedCloudSnapshot(
        memoryPendingSnapshots.get(key),
        expectedSnapshot,
      )
    ) {
      memoryPendingSnapshots.delete(key);
    }
  },
};

const indexedDbCloudSavePersistence: CloudSavePersistence = {
  list: async () => {
    const [draftKeys, summaries] = await cloudSaveStore("readonly", (store) =>
      Promise.all([
        promisifyRequest(store.getAllKeys()),
        promisifyRequest<CloudDraftSummary[]>(
          store.getAll(
            IDBKeyRange.bound(
              DRAFT_SUMMARY_PREFIX,
              `${DRAFT_SUMMARY_PREFIX}\uffff`,
            ),
          ),
        ),
      ]),
    );
    const summariesByKey = new Map(
      summaries.map((summary) => [summary.key, summary]),
    );
    return draftKeys.flatMap((key) =>
      typeof key === "string" && !key.startsWith(DRAFT_SUMMARY_PREFIX)
        ? [summariesByKey.get(key) ?? { key, name: getDraftSceneId(key) }]
        : [],
    );
  },
  load: (key) => get(key, cloudSaveStore),
  save: async (snapshot) => {
    const summary = describeDraft(snapshot);
    await cloudSaveStore("readwrite", (store) => {
      store.put(snapshot, summary.key);
      store.put(summary, DRAFT_SUMMARY_PREFIX + summary.key);
      return promisifyRequest(store.transaction);
    });
  },
  remove: async (sceneId, expectedSnapshot) => {
    // Compare and delete inside one transaction. Another tab may have written
    // a newer edit while this editor's network request was in flight.
    await cloudSaveStore("readwrite", (store) => {
      const key = expectedSnapshot ? getSnapshotKey(expectedSnapshot) : sceneId;
      const request = store.get(key);
      request.onsuccess = () => {
        if (
          !expectedSnapshot ||
          matchesPersistedCloudSnapshot(request.result, expectedSnapshot)
        ) {
          store.delete(key);
          store.delete(DRAFT_SUMMARY_PREFIX + key);
        }
      };
      return promisifyRequest(store.transaction);
    });
  },
};

const getDefaultCloudSavePersistence = () =>
  typeof indexedDB === "undefined"
    ? memoryCloudSavePersistence
    : indexedDbCloudSavePersistence;

const isCloudSaveSnapshot = (value: unknown): value is CloudSaveSnapshot =>
  Boolean(
    value &&
    typeof value === "object" &&
    "sceneId" in value &&
    typeof value.sceneId === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "elements" in value &&
    Array.isArray(value.elements) &&
    "appState" in value &&
    value.appState !== null &&
    typeof value.appState === "object" &&
    "files" in value &&
    value.files !== null &&
    typeof value.files === "object",
  );

const SESSION_RECOVERY_KEY_PREFIX = "excalidraw_cloud_save_recovery_v1:";
const DRAFT_OWNER_KEY_PREFIX = "excalidraw_cloud_draft_owner:";
const MAX_SESSION_RECOVERY_SNAPSHOT_CHARS = 2 * 1024 * 1024;

const getSessionRecoveryKey = (sceneId: string) =>
  `${SESSION_RECOVERY_KEY_PREFIX}${encodeURIComponent(sceneId)}`;

const getPreviousDraftOwner = (sceneId: string) => {
  try {
    return window.sessionStorage.getItem(DRAFT_OWNER_KEY_PREFIX + sceneId);
  } catch {
    return null;
  }
};

const forgetPreviousDraftOwner = (snapshot: CloudSaveSnapshot) => {
  if (getPreviousDraftOwner(snapshot.sceneId) !== snapshot.draftOwner) return;
  try {
    window.sessionStorage.removeItem(DRAFT_OWNER_KEY_PREFIX + snapshot.sceneId);
  } catch {
    // Storage may be unavailable in this document.
  }
};

const rememberDraftOwner = (snapshot: CloudSaveSnapshot) => {
  if (!snapshot.draftOwner) return;
  try {
    window.sessionStorage.setItem(
      DRAFT_OWNER_KEY_PREFIX + snapshot.sceneId,
      snapshot.draftOwner,
    );
  } catch {
    // A separate recovery action remains available when storage is restricted.
  }
};

const writeSessionSnapshotRecovery = (snapshot: CloudSaveSnapshot) => {
  try {
    const storage = window.sessionStorage;
    const key = getSessionRecoveryKey(snapshot.sceneId);
    const existing = storage.getItem(key);
    if (existing) {
      try {
        const parsed: unknown = JSON.parse(existing);
        if (
          isCloudSaveSnapshot(parsed) &&
          snapshot.persistenceId &&
          parsed.persistenceId === snapshot.persistenceId
        ) {
          return true;
        }
      } catch {
        // Replace malformed recovery data with the latest known snapshot.
      }
    }
    let serialized = JSON.stringify(snapshot);
    if (serialized.length > MAX_SESSION_RECOVERY_SNAPSHOT_CHARS) {
      // Images are persisted separately in IndexedDB/cloud storage; strip
      // embedded file payloads first so structure and text edits survive reload.
      const compactSnapshot: CloudSaveSnapshot = { ...snapshot, files: {} };
      serialized = JSON.stringify(compactSnapshot);
      if (serialized.length > MAX_SESSION_RECOVERY_SNAPSHOT_CHARS) {
        storage.removeItem(key);
        return false;
      }
    }
    storage.setItem(key, serialized);
    return true;
  } catch {
    // sessionStorage may be disabled or full; the in-memory queue still owns it.
    return false;
  }
};

const removeSessionSnapshotRecovery = (
  sceneId: string,
  expectedSnapshot?: CloudSaveSnapshot,
) => {
  try {
    const storage = window.sessionStorage;
    const key = getSessionRecoveryKey(sceneId);
    if (expectedSnapshot) {
      const serialized = storage.getItem(key);
      if (!serialized) {
        return;
      }
      const parsed: unknown = JSON.parse(serialized);
      if (
        !isCloudSaveSnapshot(parsed) ||
        !matchesPersistedCloudSnapshot(parsed, expectedSnapshot)
      ) {
        return;
      }
    }
    storage.removeItem(key);
  } catch {
    // The IndexedDB copy remains the durable source when available.
  }
};

const loadSessionSnapshotRecovery = (sceneId: string) => {
  try {
    const serialized = window.sessionStorage.getItem(
      getSessionRecoveryKey(sceneId),
    );
    const parsed: unknown = serialized ? JSON.parse(serialized) : null;
    return isCloudSaveSnapshot(parsed) && parsed.sceneId === sceneId
      ? parsed
      : undefined;
  } catch {
    // An inaccessible or malformed fallback does not affect IndexedDB.
    return undefined;
  }
};

const cloneCloudSaveSnapshot = (
  snapshot: CloudSaveSnapshot,
): CloudSaveSnapshot => ({
  ...snapshot,
  elements: [...snapshot.elements],
  appState: { ...snapshot.appState },
  files: Object.fromEntries(
    Object.entries(snapshot.files).map(([fileId, file]) => [
      fileId,
      { ...file },
    ]),
  ),
});

const RETRY_DELAYS_MS = [500, 1000, 2000];
const AUTO_SAVE_DELAY_MS = 30_000;

export type CloudTabSyncMessage =
  | {
      type: "scene_saved";
      sceneId: string;
      revision: number;
      metadataChanged?: boolean;
    }
  | { type: "scene_renamed"; sceneId: string; name: string; revision: number }
  | { type: "scene_deleted"; sceneId: string }
  | { type: "workspace_changed" };

const CLOUD_SYNC_CHANNEL_NAME = "excalidraw_cloud_tab_sync";
const CLOUD_SYNC_STORAGE_KEY = "excalidraw_cloud_tab_sync_message";
const CLOUD_SYNC_CLIENT_ID =
  typeof window !== "undefined" &&
  typeof window.crypto?.randomUUID === "function"
    ? window.crypto.randomUUID()
    : `${Date.now()}_${Math.random()}`;

let cloudSyncPublisher: BroadcastChannel | null = null;

type CloudTabSyncEnvelope = CloudTabSyncMessage & { sourceId?: string };

const parseCloudTabSyncMessage = (
  value: unknown,
): CloudTabSyncEnvelope | null => {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return null;
  }
  return value as CloudTabSyncEnvelope;
};

const getCloudSyncPublisher = () => {
  if (!cloudSyncPublisher) {
    cloudSyncPublisher = new BroadcastChannel(CLOUD_SYNC_CHANNEL_NAME);
  }
  return cloudSyncPublisher;
};

export const broadcastCloudSync = (message: CloudTabSyncMessage) => {
  const payload: CloudTabSyncEnvelope = {
    ...message,
    sourceId: CLOUD_SYNC_CLIENT_ID,
  };
  if (message.type === "workspace_changed" && typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        CLOUD_SYNC_STORAGE_KEY,
        JSON.stringify({
          ...payload,
          nonce: `${Date.now()}_${Math.random()}`,
        }),
      );
      return;
    } catch {
      // Continue with BroadcastChannel when storage is unavailable.
    }
  }
  if (typeof BroadcastChannel !== "undefined") {
    try {
      getCloudSyncPublisher().postMessage(payload);
    } catch {
      // BroadcastChannel might be unavailable or restricted in sandboxed environments
      cloudSyncPublisher?.close();
      cloudSyncPublisher = null;
    }
  }
};

export const broadcastWorkspaceChanged = () => {
  broadcastCloudSync({ type: "workspace_changed" });
};

export const subscribeCloudTabSync = (
  callback: (message: CloudTabSyncMessage) => void,
) => {
  if (typeof window === "undefined") {
    return () => {};
  }
  let channel: BroadcastChannel | null = null;
  let channelListener: ((event: MessageEvent) => void) | null = null;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(CLOUD_SYNC_CHANNEL_NAME);
      channelListener = (event: MessageEvent) => {
        const message = parseCloudTabSyncMessage(event.data);
        if (message && message.sourceId !== CLOUD_SYNC_CLIENT_ID) {
          callback(message);
        }
      };
      channel.addEventListener("message", channelListener);
    }
  } catch {
    channel?.close();
    channel = null;
    channelListener = null;
  }

  const storageListener = (event: StorageEvent) => {
    if (event.key !== CLOUD_SYNC_STORAGE_KEY || !event.newValue) {
      return;
    }
    try {
      const message = parseCloudTabSyncMessage(JSON.parse(event.newValue));
      if (message && message.sourceId !== CLOUD_SYNC_CLIENT_ID) {
        callback(message);
      }
    } catch {
      // Ignore malformed cross-tab payloads.
    }
  };
  window.addEventListener("storage", storageListener);
  return () => {
    if (channel && channelListener) {
      channel.removeEventListener("message", channelListener);
    }
    channel?.close();
    window.removeEventListener("storage", storageListener);
  };
};

export type CloudRealtimeEvent =
  | {
      type: "scene_changed";
      sceneId: string;
      revision: number;
      updatedAt: number;
      changeKind:
        | "created"
        | "content"
        | "metadata"
        | "thumbnail"
        | "deleted"
        | "restored";
    }
  | {
      type: "workspace_changed";
      updatedAt: number;
      sceneId?: string;
      revision?: number;
      metadataChanged?: boolean;
      changeKind?:
        | "created"
        | "content"
        | "metadata"
        | "thumbnail"
        | "deleted"
        | "restored"
        | "opened";
    }
  | { type: "ready" | "subscribed"; sceneId: string | null };

const parseCloudRealtimeEvent = (value: unknown): CloudRealtimeEvent | null => {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return null;
  }
  const event = value as Partial<CloudRealtimeEvent>;
  if (event.type === "workspace_changed") {
    return typeof event.updatedAt === "number"
      ? (event as CloudRealtimeEvent)
      : null;
  }
  if (event.type === "ready" || event.type === "subscribed") {
    return event.sceneId === null || typeof event.sceneId === "string"
      ? (event as CloudRealtimeEvent)
      : null;
  }
  if (
    event.type === "scene_changed" &&
    typeof event.sceneId === "string" &&
    typeof event.revision === "number" &&
    typeof event.updatedAt === "number" &&
    typeof event.changeKind === "string"
  ) {
    return event as CloudRealtimeEvent;
  }
  return null;
};

export const subscribeCloudRealtime = (
  sceneId: string | null,
  callback: (event: CloudRealtimeEvent) => void,
) => {
  if (
    typeof window === "undefined" ||
    typeof WebSocket === "undefined" ||
    typeof window.location?.host !== "string"
  ) {
    return () => {};
  }

  let closed = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = (delay?: number) => {
    if (closed || reconnectTimer || document.visibilityState === "hidden") {
      return;
    }
    const backoff = Math.min(30_000, 500 * 2 ** Math.min(reconnectAttempt, 6));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = null;
        connect();
      },
      delay ?? backoff + Math.floor(Math.random() * 250),
    );
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      if (!socket || socket.readyState === WebSocket.CLOSED) {
        scheduleReconnect(0);
      }
    }
  };

  const connect = () => {
    if (closed || document.visibilityState === "hidden") {
      return;
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(`${protocol}//${window.location.host}/api/realtime`);
    if (sceneId) {
      url.searchParams.set("scene_id", sceneId);
    }
    try {
      const nextSocket = new WebSocket(url);
      socket = nextSocket;
      nextSocket.addEventListener("open", () => {
        reconnectAttempt = 0;
      });
      nextSocket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          return;
        }
        try {
          const parsed = parseCloudRealtimeEvent(JSON.parse(event.data));
          if (parsed) {
            callback(parsed);
          }
        } catch {
          // Ignore malformed or non-JSON messages from a proxy.
        }
      });
      nextSocket.addEventListener("close", () => {
        if (socket === nextSocket) {
          socket = null;
        }
        scheduleReconnect();
      });
      nextSocket.addEventListener("error", () => {
        nextSocket.close();
      });
    } catch {
      scheduleReconnect();
    }
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  connect();

  return () => {
    closed = true;
    clearReconnectTimer();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    const activeSocket = socket;
    socket = null;
    activeSocket?.close(1000, "client closed");
  };
};

const sleep = (duration: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, duration));

export class CloudSaveQueue {
  private readonly pending = new Map<string, CloudSaveSnapshot>();
  private readonly restoring = new Map<string, Promise<void>>();
  private readonly recoveredDrafts = new Map<string, CloudSaveSnapshot>();
  private readonly conflicts = new Map<string, CloudSaveSnapshot>();
  private readonly revisions = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly blocked = new Map<string, BlockReason>();
  private readonly disposed = new Set<string>();
  private readonly statuses = new Map<string, CloudSaveStatus>();
  private readonly persistenceWriters = new Map<
    string,
    CloudSavePersistenceWriter
  >();
  private readonly persistenceErrors = new Map<string, Error>();
  private readonly generations = new Map<string, number>();
  private isSaving = false;
  private isDisposed = false;
  private activeSceneId: string | null = null;
  private activeSnapshot: CloudSaveSnapshot | null = null;
  private activeFlushPromise: Promise<void> | null = null;
  private readonly dependencies: CloudSaveDependencies;
  private readonly hasDurableSnapshotPersistence: boolean;

  constructor(
    private readonly callbacks: QueueCallbacks,
    dependencies: Partial<CloudSaveDependencies> = {},
  ) {
    this.dependencies = {
      fetchCloudScene,
      saveCloudScene,
      saveFilesToCloud: (files, options) =>
        saveFilesToCloud(files, { ...options, preserveExisting: true }),
      persistence: getDefaultCloudSavePersistence(),
      ...dependencies,
    };
    this.hasDurableSnapshotPersistence =
      dependencies.persistence !== undefined ||
      typeof indexedDB !== "undefined";
  }

  /** Restore only the board about to be opened. */
  restoreScene(sceneId: string) {
    const restoring = this.restoring.get(sceneId);
    if (restoring) return restoring;
    const load = this.restorePersistedSnapshot(sceneId).finally(() => {
      this.restoring.delete(sceneId);
    });
    this.restoring.set(sceneId, load);
    return load;
  }

  /** Re-enable writes only after the server confirms that the board exists. */
  reopenScene(sceneId: string) {
    this.disposed.delete(sceneId);
    if (this.blocked.get(sceneId) !== "deleted") return false;
    const snapshot = this.pending.get(sceneId)!;
    this.blocked.set(sceneId, "conflict");
    this.conflicts.set(sceneId, snapshot);
    this.setStatus(sceneId, "conflict");
    this.callbacks.onConflict(sceneId, snapshot);
    return true;
  }

  /** Retry recovered or previously failed snapshots after connectivity/auth is available. */
  resumePending() {
    if (this.isDisposed) {
      return;
    }
    for (const sceneId of this.pending.keys()) {
      if (!this.blocked.has(sceneId)) {
        this.setStatus(sceneId, "pending");
        this.schedule(sceneId, 0);
      }
    }
  }

  retryPending() {
    this.resumePending();
  }

  getPersistenceError(sceneId: string) {
    return this.persistenceErrors.get(sceneId) || null;
  }

  hasPending(sceneId: string) {
    return (
      this.pending.has(sceneId) ||
      this.conflicts.has(sceneId) ||
      this.activeSnapshot?.sceneId === sceneId
    );
  }

  getPendingSnapshot(sceneId: string) {
    const snapshot =
      this.pending.get(sceneId) ||
      this.conflicts.get(sceneId) ||
      (this.activeSceneId === sceneId ? this.activeSnapshot : null);
    return snapshot ? cloneCloudSaveSnapshot(snapshot) : null;
  }

  async listOtherDrafts() {
    const [drafts, locks] = await Promise.all([
      this.dependencies.persistence.list(),
      getDraftLocks()?.query(),
    ]);
    const held = new Set(locks?.held?.map(({ name }) => name));
    return drafts.filter(({ key }) => {
      const lockName = getDraftLockName(key);
      return (
        !this.isDraftInUse(key) &&
        (!held.has(lockName) || heldDraftLocks.has(lockName))
      );
    });
  }

  private isDraftInUse(key: string) {
    const sceneId = getDraftSceneId(key);
    return (
      this.restoring.has(sceneId) ||
      [
        this.pending.get(sceneId),
        this.conflicts.get(sceneId),
        this.recoveredDrafts.get(sceneId),
        this.activeSnapshot,
      ].some((snapshot) => snapshot && getSnapshotKey(snapshot) === key)
    );
  }

  async readOtherDraft(key: string) {
    return this.withOtherDraftLock(key, async () => {
      const snapshot = await this.dependencies.persistence.load(key);
      if (!isCloudSaveSnapshot(snapshot) || getSnapshotKey(snapshot) !== key) {
        throw new Error("这份草稿已处理，请重新打开草稿列表");
      }
      return snapshot;
    });
  }

  async forgetOtherDraft(
    draft: CloudDraftSummary,
    expected?: CloudSaveSnapshot,
  ) {
    if (!canDiscardOtherCloudDrafts()) return;
    const { key, persistenceId } = draft;
    await this.withOtherDraftLock(key, async () => {
      const snapshot =
        expected ?? (await this.dependencies.persistence.load(key));
      if (isCloudSaveSnapshot(snapshot) && getSnapshotKey(snapshot) === key) {
        if (
          !expected &&
          persistenceId &&
          persistenceId !== snapshot.persistenceId
        ) {
          throw new Error("这份草稿已更新，请重新打开草稿列表");
        }
        await this.dependencies.persistence.remove(snapshot.sceneId, snapshot);
        removeSessionSnapshotRecovery(snapshot.sceneId, snapshot);
      }
    });
  }

  private async withOtherDraftLock<T>(key: string, run: () => Promise<T>) {
    const useDraft = () => {
      if (this.isDraftInUse(key)) {
        throw new Error("这份草稿已在当前编辑器中打开");
      }
      return run();
    };
    const locks = getDraftLocks();
    const lockName = getDraftLockName(key);
    if (!locks || (await heldDraftLocks.get(lockName))) return useDraft();
    return locks.request(lockName, { ifAvailable: true }, (lock) => {
      if (!lock) throw new Error("这份草稿正在其他标签页中使用");
      return useDraft();
    });
  }

  getUnavailableScenes() {
    return [...this.blocked]
      .filter(([, reason]) => reason === "deleted")
      .flatMap(([sceneId]) => {
        const snapshot = this.pending.get(sceneId);
        return snapshot ? [{ sceneId, name: snapshot.name }] : [];
      });
  }

  getStatus(sceneId: string): CloudSaveStatus {
    return this.statuses.get(sceneId) || "idle";
  }

  getMemoryStats() {
    const snapshots = new Set([
      ...this.pending.values(),
      ...this.conflicts.values(),
      ...(this.activeSnapshot ? [this.activeSnapshot] : []),
    ]);
    let filesBytes = 0;
    let elementCount = 0;
    for (const snapshot of snapshots) {
      elementCount += snapshot.elements.length;
      for (const file of Object.values(snapshot.files)) {
        filesBytes += file.dataURL.length * 2;
      }
    }
    return {
      snapshotCount: snapshots.size,
      elementCount,
      filesBytes,
      saving: this.isSaving,
    };
  }

  setRevision(sceneId: string, revision: number) {
    this.revisions.set(sceneId, revision);
  }

  getRevision(sceneId: string) {
    return this.revisions.get(sceneId);
  }

  enqueue(snapshot: CloudSaveSnapshot) {
    if (this.isDisposed || this.disposed.has(snapshot.sceneId)) {
      return;
    }
    const queuedSnapshot = cloneCloudSaveSnapshot({
      ...snapshot,
      draftOwner: CLOUD_SYNC_CLIENT_ID,
      draftUpdatedAt: Date.now(),
      persistenceId:
        globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random()}`,
      baseRevision:
        snapshot.baseRevision ?? this.revisions.get(snapshot.sceneId),
    });
    this.pending.set(snapshot.sceneId, queuedSnapshot);
    void this.persistSnapshot(queuedSnapshot, true);
    if (
      this.activeSnapshot?.sceneId !== snapshot.sceneId &&
      !this.blocked.has(snapshot.sceneId)
    ) {
      // A blocked scene will not flush, so advertising "pending" would tell the
      // user the edit is on its way when it is actually sitting still.
      this.setStatus(snapshot.sceneId, "pending");
    }
    this.schedule(snapshot.sceneId);
  }

  cancel(sceneId: string) {
    const snapshot =
      this.pending.get(sceneId) ||
      this.conflicts.get(sceneId) ||
      (this.activeSceneId === sceneId ? this.activeSnapshot : null);
    const timer = this.timers.get(sceneId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sceneId);
    }
    this.pending.delete(sceneId);
    this.conflicts.delete(sceneId);
    this.blocked.delete(sceneId);
    this.revisions.delete(sceneId);
    this.disposed.add(sceneId);
    if (this.activeSceneId === sceneId) this.activeSnapshot = null;
    removeSessionSnapshotRecovery(sceneId);
    if (snapshot) {
      void this.removePersistedSnapshot(sceneId, snapshot);
      void this.removeRecoveredDraft(sceneId, snapshot);
    }
    this.setStatus(sceneId, "idle");
  }

  /** Keep a deleted scene's latest local edit available for recovery as a new board. */
  preserveForRecovery(sceneId: string) {
    const snapshot =
      this.pending.get(sceneId) ||
      this.conflicts.get(sceneId) ||
      (this.activeSceneId === sceneId ? this.activeSnapshot : null);
    if (!snapshot) {
      return false;
    }
    const timer = this.timers.get(sceneId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sceneId);
    }
    this.pending.set(sceneId, snapshot);
    this.conflicts.delete(sceneId);
    this.blocked.set(sceneId, "deleted");
    if (this.activeSceneId === sceneId) this.activeSnapshot = null;
    this.setStatus(sceneId, "error");
    void this.persistSnapshot(snapshot);
    return true;
  }

  resumeAfterAuth(sceneId: string) {
    if (this.blocked.get(sceneId) === "auth") {
      this.blocked.delete(sceneId);
      this.setStatus(sceneId, "pending");
      this.schedule(sceneId, 0);
    }
  }

  /**
   * The user dismissed the sign-in prompt without authenticating. Keep the
   * snapshot queued, but release the block: otherwise nothing will ever flush
   * this scene again and every later edit fails silently.
   */
  releaseAuthBlock(sceneId: string) {
    if (this.blocked.get(sceneId) === "auth") {
      this.blocked.delete(sceneId);
      if (this.pending.has(sceneId)) {
        this.setStatus(sceneId, "error");
      }
    }
  }

  resolveConflict(sceneId: string, revision: number, keepLocal: boolean) {
    if (this.disposed.has(sceneId)) {
      return;
    }
    const snapshot = this.pending.get(sceneId) || this.conflicts.get(sceneId);
    this.pending.delete(sceneId);
    this.conflicts.delete(sceneId);
    this.blocked.delete(sceneId);
    this.revisions.set(sceneId, revision);
    if (keepLocal && snapshot) {
      const updatedSnapshot = { ...snapshot, baseRevision: revision };
      this.pending.set(sceneId, updatedSnapshot);
      void this.persistSnapshot(updatedSnapshot);
      this.setStatus(sceneId, "pending");
      this.schedule(sceneId, 0);
    } else {
      if (snapshot) {
        void this.removePersistedSnapshot(sceneId, snapshot);
        void this.removeRecoveredDraft(sceneId, snapshot);
      }
      this.setStatus(sceneId, "idle");
    }
  }

  /**
   * Wait until the selected scene has no pending save left, or until it is
   * blocked by authentication/conflict handling. Failed network saves stay in
   * the queue and can be retried by calling this method again.
   */
  async flush(sceneId?: string): Promise<CloudSaveStatus> {
    if (sceneId) await this.restoring.get(sceneId);
    if (sceneId) {
      const timer = this.timers.get(sceneId);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(sceneId);
      }
    } else {
      for (const timer of this.timers.values()) {
        clearTimeout(timer);
      }
      this.timers.clear();
    }

    while (true) {
      if (this.isDisposed) {
        return sceneId ? this.getStatus(sceneId) : "idle";
      }
      if (this.activeFlushPromise) {
        await this.activeFlushPromise;
        // Another waiter may have started the next save while this call was
        // suspended. Recheck ownership before selecting or publishing a flush.
        continue;
      }

      const targetSceneId = sceneId
        ? this.pending.has(sceneId)
          ? sceneId
          : null
        : [...this.pending.keys()].find(
            (pendingSceneId) =>
              !this.blocked.has(pendingSceneId) &&
              this.getStatus(pendingSceneId) !== "error",
          ) || null;
      if (!targetSceneId) {
        return sceneId ? this.getStatus(sceneId) : "idle";
      }

      const flushPromise = this.flushScene(targetSceneId);
      this.activeFlushPromise = flushPromise;
      try {
        await flushPromise;
      } finally {
        if (this.activeFlushPromise === flushPromise) {
          this.activeFlushPromise = null;
        }
      }

      if (
        (sceneId &&
          (!this.pending.has(sceneId) ||
            this.blocked.has(sceneId) ||
            this.getStatus(sceneId) === "error")) ||
        (!sceneId && this.pending.size === 0)
      ) {
        return this.getStatus(sceneId || targetSceneId);
      }
    }
  }

  flushAll(): Promise<CloudSaveStatus> {
    return this.flush();
  }

  /** React StrictMode replays setup/cleanup with the same queue instance. */
  activate() {
    this.isDisposed = false;
  }

  dispose() {
    if (
      this.activeSceneId &&
      this.activeSnapshot &&
      !this.pending.has(this.activeSceneId)
    ) {
      this.pending.set(this.activeSceneId, this.activeSnapshot);
    }
    this.protectPendingSnapshotsForUnload();
    this.isDisposed = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    // Pending snapshots are already persisted in IndexedDB. Do not start a
    // fire-and-forget network flush from React cleanup; the next editor
    // instance restores and retries them after authentication is available.
  }

  /**
   * Keep an unload-time recovery copy when IndexedDB has not confirmed the
   * current snapshot. This is synchronous and bounded so beforeunload/pagehide
   * can protect snapshots that would otherwise exist only in this tab's heap.
   */
  protectPendingSnapshotsForUnload(force = false) {
    const snapshots = new Map<string, CloudSaveSnapshot>();
    if (this.activeSceneId && this.activeSnapshot) {
      snapshots.set(this.activeSceneId, this.activeSnapshot);
    }
    for (const [sceneId, snapshot] of this.conflicts) {
      snapshots.set(sceneId, snapshot);
    }
    for (const [sceneId, snapshot] of this.pending) {
      snapshots.set(sceneId, snapshot);
    }
    for (const [sceneId, snapshot] of snapshots) {
      const writer = this.persistenceWriters.get(sceneId);
      if (
        force ||
        !this.hasDurableSnapshotPersistence ||
        writer?.running ||
        this.persistenceErrors.has(sceneId)
      ) {
        if (writeSessionSnapshotRecovery(snapshot))
          rememberDraftOwner(snapshot);
      }
    }
  }

  private schedule(sceneId: string, delay = AUTO_SAVE_DELAY_MS) {
    if (
      this.isDisposed ||
      this.disposed.has(sceneId) ||
      this.blocked.has(sceneId) ||
      this.timers.has(sceneId)
    ) {
      return;
    }
    this.timers.set(
      sceneId,
      setTimeout(() => {
        this.timers.delete(sceneId);
        void this.flush(sceneId);
      }, delay),
    );
  }

  private setStatus(sceneId: string, status: CloudSaveStatus) {
    if (this.statuses.get(sceneId) === status) {
      return;
    }
    this.statuses.set(sceneId, status);
    if (!this.isDisposed) {
      this.callbacks.onStatusChange?.(sceneId, status);
    }
  }

  private async flushScene(sceneId: string) {
    if (
      this.isDisposed ||
      this.isSaving ||
      this.disposed.has(sceneId) ||
      this.blocked.has(sceneId)
    ) {
      return;
    }
    const snapshot = this.pending.get(sceneId);
    if (!snapshot) {
      return;
    }
    this.pending.delete(sceneId);
    this.isSaving = true;
    this.activeSceneId = sceneId;
    this.activeSnapshot = snapshot;
    this.setStatus(sceneId, "saving");
    // Reopening a restored board must not re-enable its cancelled request.
    const isCurrentSave = () =>
      !this.isDisposed && this.activeSnapshot === snapshot;

    try {
      await this.waitForPersistence(sceneId);
      let forceUpload = false;
      for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
        let sentSnapshot = snapshot;
        try {
          if (!isCurrentSave()) {
            return;
          }
          const replacements = await this.dependencies.saveFilesToCloud(
            snapshot.files,
            forceUpload ? { forceUpload: true } : undefined,
          );
          if (replacements?.size) {
            sentSnapshot = remapCloudSnapshotFiles(snapshot, replacements);
          }
          if (!isCurrentSave()) {
            return;
          }
          const saved = await this.dependencies.saveCloudScene(sceneId, {
            name: snapshot.name,
            elements:
              sentSnapshot.elements as readonly NonDeletedExcalidrawElement[],
            appState: snapshot.appState,
            baseRevision: snapshot.baseRevision,
          });
          if (!isCurrentSave()) {
            return;
          }
          await this.markSnapshotSaved(
            sceneId,
            snapshot,
            saved.revision,
            sentSnapshot,
            saved.metadataChanged,
          );
          break;
        } catch (error) {
          if (!isCurrentSave()) {
            return;
          }
          if (error instanceof CloudApiError && error.status === 401) {
            if (!this.pending.has(sceneId)) {
              this.pending.set(sceneId, snapshot);
            }
            this.blocked.set(sceneId, "auth");
            this.setStatus(sceneId, "auth");
            this.callbacks.onAuthRequired(sceneId);
            return;
          }
          if (error instanceof CloudApiError && error.status === 404) {
            if (!this.pending.has(sceneId)) {
              this.pending.set(sceneId, snapshot);
            }
            const recoverySnapshot = this.pending.get(sceneId)!;
            this.blocked.set(sceneId, "deleted");
            this.setStatus(sceneId, "error");
            void this.persistSnapshot(recoverySnapshot);
            this.callbacks.onSceneUnavailable?.(
              sceneId,
              cloneCloudSaveSnapshot(recoverySnapshot),
            );
            return;
          }
          if (error instanceof CloudApiError && error.status === 409) {
            try {
              const remote = await this.dependencies.fetchCloudScene(sceneId, {
                forceRefresh: true,
              });
              if (!isCurrentSave()) return;
              if (this.snapshotMatchesScene(sentSnapshot, remote)) {
                await this.markSnapshotSaved(
                  sceneId,
                  snapshot,
                  remote.revision,
                  sentSnapshot,
                  true,
                );
                break;
              }
            } catch {
              // Leave the snapshot in the queue and use normal conflict handling.
            }
            if (!isCurrentSave()) return;
            this.conflicts.set(sceneId, snapshot);
            this.blocked.set(sceneId, "conflict");
            this.setStatus(sceneId, "conflict");
            this.callbacks.onConflict(sceneId, snapshot);
            return;
          }
          if (
            error instanceof CloudApiError &&
            error.status === 422 &&
            error.code === "MISSING_FILE" &&
            attempt < RETRY_DELAYS_MS.length - 1
          ) {
            // Upload caches describe a past server state. GC can reclaim an
            // image while it remains available locally for undo/recovery.
            // The rejected scene write has not committed; retry its original
            // revision after renewing every attachment, within this budget.
            forceUpload = true;
            continue;
          }
          if (attempt === RETRY_DELAYS_MS.length - 1) {
            if (!this.pending.has(sceneId)) {
              this.pending.set(sceneId, snapshot);
            }
            this.setStatus(sceneId, "error");
            this.callbacks.onError(
              this.persistenceErrors.get(sceneId) ||
                (error instanceof Error ? error : new Error("云端保存失败")),
            );
            return;
          }
          await sleep(RETRY_DELAYS_MS[attempt]);
        }
      }
    } finally {
      this.isSaving = false;
      this.activeSceneId = null;
      this.activeSnapshot = null;
      for (const pendingSceneId of this.pending.keys()) {
        if (
          !this.isDisposed &&
          !this.blocked.has(pendingSceneId) &&
          this.getStatus(pendingSceneId) !== "error"
        ) {
          this.setStatus(pendingSceneId, "pending");
          this.schedule(pendingSceneId, 0);
        }
      }
    }
  }

  private async restorePersistedSnapshot(sceneId: string) {
    if (this.hasPending(sceneId)) return;
    const ownKey = getDraftKey(sceneId, CLOUD_SYNC_CLIENT_ID);
    const previousOwner = getPreviousDraftOwner(sceneId);
    const fallback = loadSessionSnapshotRecovery(sceneId);
    const locksAvailable = canDiscardOtherCloudDrafts();
    const sharedStorageWithoutLocks =
      !locksAvailable && typeof indexedDB !== "undefined";
    const candidates = new Set([ownKey]);
    if (previousOwner) candidates.add(getDraftKey(sceneId, previousOwner));
    if (fallback) candidates.add(getSnapshotKey(fallback));
    if (!sharedStorageWithoutLocks) candidates.add(sceneId);
    try {
      for (const key of candidates) {
        const session =
          fallback && getSnapshotKey(fallback) === key ? fallback : undefined;
        let saved = await this.dependencies.persistence
          .load(key)
          .catch((error: unknown) => {
            this.callbacks.onError(
              error instanceof Error
                ? error
                : new Error("恢复本地云端保存失败"),
            );
            return undefined;
          });
        if (!saved && !session) continue;
        if (key !== ownKey && locksAvailable) {
          if (!(await holdDraftLock(key))) continue;
          saved = await this.dependencies.persistence.load(key);
        }
        const snapshot =
          session &&
          (session.draftUpdatedAt ?? 0) >= (saved?.draftUpdatedAt ?? 0)
            ? session
            : saved;
        if (!isCloudSaveSnapshot(snapshot) || getSnapshotKey(snapshot) !== key)
          continue;
        if (
          this.hasPending(sceneId) ||
          this.isDisposed ||
          this.disposed.has(sceneId)
        )
          return;
        const restored = cloneCloudSaveSnapshot(
          key !== ownKey && sharedStorageWithoutLocks
            ? { ...snapshot, draftOwner: CLOUD_SYNC_CLIENT_ID }
            : snapshot,
        );
        this.pending.set(sceneId, restored);
        this.recoveredDrafts.set(sceneId, snapshot);
        this.setStatus(sceneId, "pending");
        return;
      }
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error("恢复本地云端保存失败");
      this.callbacks.onError(normalized);
    }
  }

  private snapshotMatchesScene(
    snapshot: CloudSaveSnapshot,
    remote: Awaited<ReturnType<typeof fetchCloudScene>>,
  ) {
    return (
      remote.name === snapshot.name &&
      remote.appState.viewBackgroundColor ===
        snapshot.appState.viewBackgroundColor &&
      remote.appState.gridSize === snapshot.appState.gridSize &&
      this.stableSerialize(remote.elements) ===
        this.stableSerialize(snapshot.elements)
    );
  }

  private stableSerialize(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableSerialize(item)).join(",")}]`;
    }
    if (value && typeof value === "object") {
      return `{${Object.keys(value)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map(
          (key) =>
            `${JSON.stringify(key)}:${this.stableSerialize(
              (value as Record<string, unknown>)[key],
            )}`,
        )
        .join(",")}}`;
    }
    return JSON.stringify(value) ?? "undefined";
  }

  private async markSnapshotSaved(
    sceneId: string,
    snapshot: CloudSaveSnapshot,
    revision: number,
    sentSnapshot = snapshot,
    metadataChanged = false,
  ) {
    this.revisions.set(sceneId, revision);
    const nextSnapshot = this.pending.get(sceneId);
    const followUpSnapshot =
      nextSnapshot?.persistenceId === snapshot.persistenceId
        ? null
        : nextSnapshot;
    if (
      followUpSnapshot &&
      followUpSnapshot.baseRevision === snapshot.baseRevision
    ) {
      const updatedSnapshot = { ...followUpSnapshot, baseRevision: revision };
      this.pending.set(sceneId, updatedSnapshot);
      await this.persistSnapshot(updatedSnapshot);
    } else if (!followUpSnapshot) {
      if (nextSnapshot) {
        this.pending.delete(sceneId);
      }
      removeSessionSnapshotRecovery(sceneId);
      await this.removePersistedSnapshot(sceneId, snapshot);
    }
    if (this.activeSnapshot !== snapshot) return;
    await this.removeRecoveredDraft(sceneId, snapshot, true);
    if (this.activeSnapshot !== snapshot) return;
    broadcastCloudSync({
      type: "scene_saved",
      sceneId,
      revision,
      metadataChanged,
    });
    this.setStatus(sceneId, followUpSnapshot ? "pending" : "saved");
    if (!this.isDisposed && !this.disposed.has(sceneId)) {
      try {
        this.callbacks.onSnapshotSaved?.(sentSnapshot, revision);
      } catch (error) {
        // Auxiliary preview work must never retry a committed scene write.
        console.warn("画板保存后回调失败", error);
      }
    }
  }

  private bumpGeneration(sceneId: string) {
    const generation = (this.generations.get(sceneId) || 0) + 1;
    this.generations.set(sceneId, generation);
    return generation;
  }

  private async removeRecoveredDraft(
    sceneId: string,
    snapshot: CloudSaveSnapshot,
    saved = false,
  ) {
    const recovered = this.recoveredDrafts.get(sceneId);
    this.recoveredDrafts.delete(sceneId);
    if (recovered && getSnapshotKey(recovered) !== getSnapshotKey(snapshot)) {
      if (!saved && !getDraftLocks() && typeof indexedDB !== "undefined") {
        forgetPreviousDraftOwner(recovered);
        return;
      }
      await this.dependencies.persistence
        .remove(sceneId, recovered)
        .catch((error) => console.warn("清理已处理的旧草稿失败", error));
    }
  }

  private persistSnapshot(snapshot: CloudSaveSnapshot, alreadyCloned = false) {
    const generation = this.bumpGeneration(snapshot.sceneId);
    const persistedSnapshot = alreadyCloned
      ? snapshot
      : cloneCloudSaveSnapshot(snapshot);
    return this.queuePersistenceWrite(snapshot.sceneId, {
      generation,
      snapshot: persistedSnapshot,
    });
  }

  private removePersistedSnapshot(
    sceneId: string,
    expectedSnapshot?: CloudSaveSnapshot,
  ) {
    removeSessionSnapshotRecovery(sceneId, expectedSnapshot);
    const generation = this.bumpGeneration(sceneId);
    return this.queuePersistenceWrite(sceneId, {
      generation,
      snapshot: null,
      expectedSnapshot,
    });
  }

  private queuePersistenceWrite(
    sceneId: string,
    operation: CloudSavePersistenceOperation,
  ) {
    let writer = this.persistenceWriters.get(sceneId);
    if (!writer) {
      writer = {
        desired: null,
        running: false,
        promise: Promise.resolve(),
      };
      this.persistenceWriters.set(sceneId, writer);
    }
    // Keep just one not-yet-written operation per scene. A newer snapshot
    // replaces an older queued clone while an IndexedDB transaction is active.
    writer.desired = operation;
    if (!writer.running) {
      writer.running = true;
      writer.promise = this.drainPersistenceWrites(sceneId, writer);
    }
    return writer.promise;
  }

  private async waitForPersistence(sceneId: string) {
    while (true) {
      const writer = this.persistenceWriters.get(sceneId);
      if (!writer) {
        return;
      }
      await writer.promise;
    }
  }

  private async drainPersistenceWrites(
    sceneId: string,
    writer: CloudSavePersistenceWriter,
  ) {
    while (writer.desired) {
      const operation = writer.desired;
      writer.desired = null;
      if ((this.generations.get(sceneId) || 0) !== operation.generation) {
        continue;
      }
      try {
        if (operation.snapshot) {
          if (
            getDraftLocks() &&
            !(await holdDraftLock(getSnapshotKey(operation.snapshot)))
          ) {
            throw new Error("无法取得本地草稿的写入权限");
          }
          await this.dependencies.persistence.save(operation.snapshot);
          rememberDraftOwner(operation.snapshot);
          const latestSnapshot = this.pending.get(sceneId);
          if (
            this.hasDurableSnapshotPersistence &&
            (!latestSnapshot ||
              latestSnapshot.persistenceId === operation.snapshot.persistenceId)
          ) {
            removeSessionSnapshotRecovery(sceneId);
          }
        } else {
          await this.dependencies.persistence.remove(
            sceneId,
            operation.expectedSnapshot,
          );
          removeSessionSnapshotRecovery(sceneId, operation.expectedSnapshot);
        }
        this.persistenceErrors.delete(sceneId);
      } catch (error) {
        const normalized =
          error instanceof Error
            ? error
            : new Error("更新本地云端保存快照失败");
        this.persistenceErrors.set(sceneId, normalized);
        if (operation.snapshot) {
          writeSessionSnapshotRecovery(operation.snapshot);
        }
        this.callbacks.onError(normalized);
      }
    }
    writer.running = false;
    if (this.persistenceWriters.get(sceneId) === writer && !writer.desired) {
      this.persistenceWriters.delete(sceneId);
    }
  }
}
