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
};

type BlockReason = "auth" | "conflict";

const RETRY_DELAYS_MS = [500, 1000, 2000];

const sleep = (duration: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, duration));

export class CloudSaveQueue {
  private readonly pending = new Map<string, CloudSaveSnapshot>();
  private readonly conflicts = new Map<string, CloudSaveSnapshot>();
  private readonly revisions = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<string>();
  private readonly blocked = new Map<string, BlockReason>();
  private readonly disposed = new Set<string>();

  constructor(private readonly callbacks: QueueCallbacks) {}

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
    this.disposed.add(sceneId);
  }

  resumeAfterAuth(sceneId: string) {
    if (this.blocked.get(sceneId) === "auth") {
      this.blocked.delete(sceneId);
      this.schedule(sceneId, 0);
    }
  }

  resolveConflict(sceneId: string, revision: number, keepLocal: boolean) {
    const snapshot = this.conflicts.get(sceneId);
    this.conflicts.delete(sceneId);
    this.blocked.delete(sceneId);
    this.revisions.set(sceneId, revision);
    if (keepLocal && snapshot) {
      this.pending.set(sceneId, snapshot);
      this.schedule(sceneId, 0);
    }
  }

  dispose() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.pending.clear();
    this.conflicts.clear();
  }

  private schedule(sceneId: string, delay = 1000) {
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

  private async flush(sceneId: string) {
    if (
      this.inFlight.has(sceneId) ||
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
    this.inFlight.add(sceneId);

    try {
      for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
        try {
          await saveFilesToCloud(snapshot.files);
          const saved = await saveCloudScene(sceneId, {
            name: snapshot.name,
            elements:
              snapshot.elements as readonly NonDeletedExcalidrawElement[],
            appState: snapshot.appState,
            baseRevision: this.revisions.get(sceneId),
          });
          this.revisions.set(sceneId, saved.revision);
          break;
        } catch (error) {
          if (error instanceof CloudApiError && error.status === 401) {
            this.pending.set(sceneId, snapshot);
            this.blocked.set(sceneId, "auth");
            this.callbacks.onAuthRequired(sceneId);
            return;
          }
          if (error instanceof CloudApiError && error.status === 409) {
            this.conflicts.set(sceneId, snapshot);
            this.blocked.set(sceneId, "conflict");
            this.callbacks.onConflict(sceneId, snapshot);
            return;
          }
          if (attempt === RETRY_DELAYS_MS.length - 1) {
            this.pending.set(sceneId, snapshot);
            this.callbacks.onError(
              error instanceof Error ? error : new Error("云端保存失败"),
            );
            return;
          }
          await sleep(RETRY_DELAYS_MS[attempt]);
        }
      }
    } finally {
      this.inFlight.delete(sceneId);
      if (this.pending.has(sceneId) && !this.blocked.has(sceneId)) {
        this.schedule(sceneId, 0);
      }
    }
  }
}
