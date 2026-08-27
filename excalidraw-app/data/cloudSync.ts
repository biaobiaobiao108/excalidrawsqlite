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
  | { type: "scene_deleted"; sceneId: string };

const CLOUD_SYNC_CHANNEL_NAME = "excalidraw_cloud_tab_sync";

export const broadcastCloudSync = (message: CloudTabSyncMessage) => {
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(CLOUD_SYNC_CHANNEL_NAME);
      channel.postMessage(message);
      channel.close();
    } catch {
      // BroadcastChannel might be unavailable or restricted in sandboxed environments
    }
  }
};

export const subscribeCloudTabSync = (
  callback: (message: CloudTabSyncMessage) => void,
) => {
  if (typeof BroadcastChannel === "undefined") {
    return () => {};
  }
  try {
    const channel = new BroadcastChannel(CLOUD_SYNC_CHANNEL_NAME);
    const listener = (event: MessageEvent<CloudTabSyncMessage>) => {
      if (
        event.data &&
        typeof event.data === "object" &&
        "type" in event.data
      ) {
        callback(event.data);
      }
    };
    channel.addEventListener("message", listener);
    return () => {
      channel.removeEventListener("message", listener);
      channel.close();
    };
  } catch {
    return () => {};
  }
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

  setRevision(sceneId: string, revision: number) {
    this.revisions.set(sceneId, revision);
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
      this.pending.set(sceneId, snapshot);
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
    this.pending.clear();
    this.conflicts.clear();
    if (this.activeSceneId) {
      this.disposed.add(this.activeSceneId);
    }
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
            baseRevision: this.revisions.get(sceneId),
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
