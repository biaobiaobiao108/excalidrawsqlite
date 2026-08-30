import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

export type ThumbnailSnapshot = {
  sceneId: string;
  elements: readonly ExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
  /** Monotonic client-side version used to reject stale cross-tab uploads. */
  thumbnailVersion?: number;
};

/**
 * Serializes thumbnail writes while dropping snapshots that were superseded
 * before their render/upload started. An upload already in flight is allowed
 * to finish, then the newest snapshot is written afterwards.
 */
export class LatestThumbnailSaveQueue<Snapshot extends { sceneId: string }> {
  private chain: Promise<void> = Promise.resolve();
  private generation = 0;

  schedule<Output>(
    snapshot: Snapshot,
    create: (snapshot: Snapshot) => Promise<Output | null>,
    save: (sceneId: string, output: Output | null) => Promise<unknown>,
    onError: (error: unknown) => void,
  ): Promise<void> {
    const generation = ++this.generation;
    const task = this.chain.then(async () => {
      if (generation !== this.generation) {
        return;
      }
      const output = await create(snapshot);
      if (generation !== this.generation) {
        return;
      }
      await save(snapshot.sceneId, output);
    });
    this.chain = task.catch(() => undefined);
    void task.catch(onError);
    return this.chain;
  }

  cancel() {
    this.generation += 1;
  }

  flush() {
    return this.chain;
  }
}
