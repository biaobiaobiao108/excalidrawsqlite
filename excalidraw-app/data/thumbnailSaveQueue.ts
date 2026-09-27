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
 * Serializes thumbnail writes with at most one active and one pending snapshot.
 * Replacing the pending snapshot releases the older one immediately. An upload
 * already in flight is allowed to finish, then the newest snapshot is written.
 */
export class LatestThumbnailSaveQueue<Snapshot extends { sceneId: string }> {
  private active: { promise: Promise<void> } | null = null;
  private pending: {
    generation: number;
    run: () => Promise<void>;
    resolve: () => void;
    onError: (error: unknown) => void;
  } | null = null;
  private generation = 0;

  schedule<Output>(
    snapshot: Snapshot,
    create: (snapshot: Snapshot) => Promise<Output | null>,
    save: (sceneId: string, output: Output | null) => Promise<unknown>,
    onError: (error: unknown) => void,
  ): Promise<void> {
    const generation = ++this.generation;
    let resolveTask!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveTask = resolve;
    });
    const task = {
      generation,
      run: async () => {
        const output = await create(snapshot);
        if (generation !== this.generation) {
          return;
        }
        await save(snapshot.sceneId, output);
      },
      resolve: resolveTask,
      onError,
    };

    if (this.active) {
      this.pending?.resolve();
      this.pending = task;
    } else {
      this.start(task);
    }
    return completion;
  }

  cancel() {
    this.generation += 1;
    this.pending?.resolve();
    this.pending = null;
  }

  async flush() {
    while (this.active || this.pending) {
      if (!this.active && this.pending) {
        const pending = this.pending;
        this.pending = null;
        this.start(pending);
      }
      const active = this.active;
      if (active) {
        await active.promise;
      }
    }
  }

  private start(
    task: {
      generation: number;
      run: () => Promise<void>;
      resolve: () => void;
      onError: (error: unknown) => void;
    },
  ) {
    const promise = Promise.resolve().then(async () => {
      try {
        if (task.generation !== this.generation) {
          return;
        }
        await task.run();
      } catch (error) {
        try {
          task.onError(error);
        } catch {
          // Error reporting must not strand the queue or its pending snapshot.
        }
      } finally {
        task.resolve();
        if (this.active?.promise === promise) {
          this.active = null;
        }
        const next = this.pending;
        this.pending = null;
        if (next) {
          this.start(next);
        }
      }
    });
    this.active = { promise };
  }
}
