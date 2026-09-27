import { VersionedSnapshotStore } from "@excalidraw/common";

import type { FileId } from "@excalidraw/element/types";

export type FileLoadingStatus = "loading" | "loaded" | "error";

export class FileStatusStore {
  private static store = new VersionedSnapshotStore<
    Map<FileId, FileLoadingStatus>
  >(new Map());
  private static readonly activeLoads = new Map<FileId, symbol>();
  private static readonly previousLoadStatuses = new Map<
    symbol,
    Map<FileId, FileLoadingStatus | undefined>
  >();

  static getSnapshot() {
    return this.store.getSnapshot();
  }

  static pull(sinceVersion?: number) {
    return this.store.pull(sinceVersion);
  }

  static updateStatuses(updates: Array<[FileId, FileLoadingStatus]>) {
    if (!updates.length) {
      return;
    }
    for (const [id] of updates) {
      const activeLoad = this.activeLoads.get(id);
      if (activeLoad) {
        this.activeLoads.delete(id);
        const previousStatuses = this.previousLoadStatuses.get(activeLoad);
        previousStatuses?.delete(id);
        if (previousStatuses?.size === 0) {
          this.previousLoadStatuses.delete(activeLoad);
        }
      }
    }
    this.applyStatuses(updates);
  }

  static beginLoading(ids: readonly FileId[]) {
    const loadToken = Symbol("file-load");
    const statuses = this.store.getSnapshot().value;
    const previousStatuses = new Map<FileId, FileLoadingStatus | undefined>();
    const updates: Array<[FileId, FileLoadingStatus]> = [];
    for (const id of new Set(ids)) {
      const previousLoad = this.activeLoads.get(id);
      const previousStatus = previousLoad
        ? this.previousLoadStatuses.get(previousLoad)?.get(id)
        : statuses.get(id);
      if (previousLoad) {
        const previousLoadStatuses = this.previousLoadStatuses.get(previousLoad);
        previousLoadStatuses?.delete(id);
        if (previousLoadStatuses?.size === 0) {
          this.previousLoadStatuses.delete(previousLoad);
        }
      }
      previousStatuses.set(id, previousStatus);
      this.activeLoads.set(id, loadToken);
      updates.push([id, "loading"]);
    }
    if (previousStatuses.size) {
      this.previousLoadStatuses.set(loadToken, previousStatuses);
    }
    this.applyStatuses(updates);
    return loadToken;
  }

  static finishLoading(
    loadToken: symbol,
    updates: Array<[FileId, FileLoadingStatus]>,
  ) {
    const ownedUpdates: Array<[FileId, FileLoadingStatus]> = [];
    for (const [id, status] of updates) {
      if (this.activeLoads.get(id) !== loadToken) {
        continue;
      }
      this.activeLoads.delete(id);
      ownedUpdates.push([id, status]);
    }
    this.previousLoadStatuses.delete(loadToken);
    this.applyStatuses(ownedUpdates);
  }

  static cancelLoading(loadToken: symbol) {
    const previousStatuses = this.previousLoadStatuses.get(loadToken);
    if (!previousStatuses) {
      return;
    }
    const restore: Array<[FileId, FileLoadingStatus]> = [];
    const remove: FileId[] = [];
    for (const [id, previousStatus] of previousStatuses) {
      if (this.activeLoads.get(id) !== loadToken) {
        continue;
      }
      this.activeLoads.delete(id);
      if (previousStatus) {
        restore.push([id, previousStatus]);
      } else {
        remove.push(id);
      }
    }
    this.previousLoadStatuses.delete(loadToken);
    this.applyStatuses(restore, remove);
  }

  private static applyStatuses(
    updates: Array<[FileId, FileLoadingStatus]>,
    remove: FileId[] = [],
  ) {
    if (!updates.length && !remove.length) {
      return;
    }
    this.store.update((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [id, status] of updates) {
        if (next.get(id) !== status) {
          next.set(id, status);
          changed = true;
        }
      }
      for (const id of remove) {
        changed = next.delete(id) || changed;
      }
      return changed ? next : prev;
    });
  }

  static getPendingCount(statuses: Map<FileId, FileLoadingStatus>) {
    let pending = 0;
    let total = 0;
    for (const status of statuses.values()) {
      total++;
      if (status === "loading") {
        pending++;
      }
    }
    return { pending, total };
  }
}
