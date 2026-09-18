import type {
  NonDeletedExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

import {
  CloudApiError,
  saveCloudScene,
  saveFilesToCloud,
} from "./cloudStorage";

export interface CloudSaveSnapshot {
  sceneId: string;
  name: string;
  elements: readonly OrderedExcalidrawElement[];
  appState: Pick<AppState, "viewBackgroundColor" | "gridSize">;
  files: BinaryFiles;
  /** Revision observed when this snapshot was created. */
  baseRevision?: number;
}

type QueueCallbacks = {
  onAuthRequired: (sceneId: string) => void;
  onConflict: (sceneId: string, snapshot: CloudSaveSnapshot) => void;
  onError: (error: Error) => void;
  onStatusChange?: (sceneId: string, status: CloudSaveStatus) => void;
};

export type CloudSaveStatus =
  | "idle"
  | "pending"
  | "saving"
  | "saved"
  | "error"
  | "auth"
  | "conflict";

type BlockReason = "auth" | "conflict";

type CloudSaveDependencies = {
  saveCloudScene: typeof saveCloudScene;
  saveFilesToCloud: typeof saveFilesToCloud;
};

const RETRY_DELAYS_MS = [500, 1000, 2000];
const AUTO_SAVE_DELAY_MS = 30_000;

export type CloudTabSyncMessage =
  | { type: "scene_saved"; sceneId: string; revision: number }
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
  }
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
  | { type: "workspace_changed"; updatedAt: number }
  | { type: "ready" | "subscribed"; sceneId: string | null };

const parseCloudRealtimeEvent = (value: unknown): CloudRealtimeEvent | null => {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return null;
  }
  const event = value as Partial<CloudRealtimeEvent>;
  if (event.type === "workspace_changed") {
    return typeof event.updatedAt === "number" ? (event as CloudRealtimeEvent) : null;
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
    if (
      closed ||
      reconnectTimer ||
      document.visibilityState === "hidden"
    ) {
      return;
    }
    const backoff = Math.min(30_000, 500 * 2 ** Math.min(reconnectAttempt, 6));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay ?? backoff + Math.floor(Math.random() * 250));
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
  private readonly conflicts = new Map<string, CloudSaveSnapshot>();
  private readonly revisions = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly blocked = new Map<string, BlockReason>();
  private readonly disposed = new Set<string>();
  private readonly statuses = new Map<string, CloudSaveStatus>();
  private isSaving = false;
  private activeSceneId: string | null = null;
  private activeSnapshot: CloudSaveSnapshot | null = null;
  private activeFlushPromise: Promise<void> | null = null;
  private readonly dependencies: CloudSaveDependencies;

  constructor(
    private readonly callbacks: QueueCallbacks,
    dependencies: Partial<CloudSaveDependencies> = {},
  ) {
    this.dependencies = {
      saveCloudScene,
      saveFilesToCloud,
      ...dependencies,
    };
  }

  hasPending(sceneId: string) {
    return (
      this.pending.has(sceneId) ||
      this.conflicts.has(sceneId) ||
      (this.isSaving && this.activeSceneId === sceneId)
    );
  }

  getStatus(sceneId: string): CloudSaveStatus {
    return this.statuses.get(sceneId) || "idle";
  }

  getMemoryStats() {
    const snapshots = [
      ...this.pending.values(),
      ...this.conflicts.values(),
      ...(this.activeSnapshot ? [this.activeSnapshot] : []),
    ];
    let filesBytes = 0;
    let elementCount = 0;
    for (const snapshot of snapshots) {
      elementCount += snapshot.elements.length;
      for (const file of Object.values(snapshot.files)) {
        filesBytes += file.dataURL.length * 2;
      }
    }
    return {
      snapshotCount: snapshots.length,
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
    if (this.disposed.has(snapshot.sceneId)) {
      return;
    }
    this.pending.set(snapshot.sceneId, {
      ...snapshot,
      elements: [...snapshot.elements],
      appState: { ...snapshot.appState },
      files: { ...snapshot.files },
      baseRevision:
        snapshot.baseRevision ?? this.revisions.get(snapshot.sceneId),
    });
    if (!(this.isSaving && this.activeSceneId === snapshot.sceneId)) {
      this.setStatus(snapshot.sceneId, "pending");
    }
    this.schedule(snapshot.sceneId);
  }

  cancel(sceneId: string) {
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
    this.setStatus(sceneId, "idle");
  }

  resumeAfterAuth(sceneId: string) {
    if (this.blocked.get(sceneId) === "auth") {
      this.blocked.delete(sceneId);
      this.setStatus(sceneId, "pending");
      this.schedule(sceneId, 0);
    }
  }

  resolveConflict(sceneId: string, revision: number, keepLocal: boolean) {
    const snapshot = this.pending.get(sceneId) || this.conflicts.get(sceneId);
    this.pending.delete(sceneId);
    this.conflicts.delete(sceneId);
    this.blocked.delete(sceneId);
    this.revisions.set(sceneId, revision);
    if (keepLocal && snapshot) {
      this.pending.set(sceneId, { ...snapshot, baseRevision: revision });
      this.setStatus(sceneId, "pending");
      this.schedule(sceneId, 0);
    } else {
      this.setStatus(sceneId, "idle");
    }
  }

  /**
   * Wait until the selected scene has no pending save left, or until it is
   * blocked by authentication/conflict handling. Failed network saves stay in
   * the queue and can be retried by calling this method again.
   */
  async flush(sceneId?: string): Promise<CloudSaveStatus> {
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
      if (this.activeFlushPromise) {
        await this.activeFlushPromise;
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

  dispose() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    // Do not discard pending snapshots on route teardown. A component can be
    // unmounted by browser history before its async save has completed; keep
    // the queue alive long enough to flush the latest durable snapshot.
    void this.flush();
  }

  private schedule(sceneId: string, delay = AUTO_SAVE_DELAY_MS) {
    if (
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
    this.callbacks.onStatusChange?.(sceneId, status);
  }

  private async flushScene(sceneId: string) {
    if (
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

    try {
      for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
        try {
          await this.dependencies.saveFilesToCloud(snapshot.files);
          if (this.disposed.has(sceneId)) {
            return;
          }
          const saved = await this.dependencies.saveCloudScene(sceneId, {
            name: snapshot.name,
            elements:
              snapshot.elements as readonly NonDeletedExcalidrawElement[],
            appState: snapshot.appState,
            baseRevision: snapshot.baseRevision,
          });
          this.revisions.set(sceneId, saved.revision);
          broadcastCloudSync({
            type: "scene_saved",
            sceneId,
            revision: saved.revision,
          });
          this.setStatus(sceneId, "saved");
          break;
        } catch (error) {
          if (error instanceof CloudApiError && error.status === 401) {
            this.pending.set(sceneId, snapshot);
            this.blocked.set(sceneId, "auth");
            this.setStatus(sceneId, "auth");
            this.callbacks.onAuthRequired(sceneId);
            return;
          }
          if (error instanceof CloudApiError && error.status === 409) {
            this.conflicts.set(sceneId, snapshot);
            this.blocked.set(sceneId, "conflict");
            this.setStatus(sceneId, "conflict");
            this.callbacks.onConflict(sceneId, snapshot);
            return;
          }
          if (attempt === RETRY_DELAYS_MS.length - 1) {
            this.pending.set(sceneId, snapshot);
            this.setStatus(sceneId, "error");
            this.callbacks.onError(
              error instanceof Error ? error : new Error("云端保存失败"),
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
          !this.blocked.has(pendingSceneId) &&
          this.getStatus(pendingSceneId) !== "error"
        ) {
          this.setStatus(pendingSceneId, "pending");
          this.schedule(pendingSceneId, 0);
        }
      }
    }
  }
}
