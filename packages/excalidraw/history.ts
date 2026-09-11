import { Emitter } from "@excalidraw/common";

import {
  CaptureUpdateAction,
  StoreChange,
  StoreDelta,
} from "@excalidraw/element";

import type { StoreSnapshot, Store } from "@excalidraw/element";

import type { SceneElementsMap } from "@excalidraw/element/types";
import type { FileId } from "@excalidraw/element/types";

import type { AppState } from "./types";

export class HistoryDelta extends StoreDelta {
  /**
   * Apply the delta to the passed elements and appState, does not modify the snapshot.
   */
  public applyTo(
    elements: SceneElementsMap,
    appState: AppState,
    snapshot: StoreSnapshot,
  ): [SceneElementsMap, AppState, boolean] {
    const [nextElements, elementsContainVisibleChange] = this.elements.applyTo(
      elements,
      // used to fallback into local snapshot in case we couldn't apply the delta
      // due to a missing (force deleted) elements in the scene
      snapshot.elements,
      // we don't want to apply the `version` and `versionNonce` properties for history
      // as we always need to end up with a new version due to collaboration,
      // approaching each undo / redo as a new user action
      {
        excludedProperties: new Set(["version", "versionNonce"]),
      },
    );

    const [nextAppState, appStateContainsVisibleChange] = this.appState.applyTo(
      appState,
      nextElements,
    );

    const appliedVisibleChanges =
      elementsContainVisibleChange || appStateContainsVisibleChange;

    return [nextElements, nextAppState, appliedVisibleChanges];
  }

  /**
   * Overriding once to avoid type casting everywhere.
   */
  public static override calculate(
    prevSnapshot: StoreSnapshot,
    nextSnapshot: StoreSnapshot,
  ) {
    return super.calculate(prevSnapshot, nextSnapshot) as HistoryDelta;
  }

  /**
   * Overriding once to avoid type casting everywhere.
   */
  public static override inverse(delta: StoreDelta): HistoryDelta {
    return super.inverse(delta) as HistoryDelta;
  }

  /**
   * Overriding once to avoid type casting everywhere.
   */
  public static override applyLatestChanges(
    delta: StoreDelta,
    prevElements: SceneElementsMap,
    nextElements: SceneElementsMap,
    modifierOptions?: "deleted" | "inserted",
  ) {
    return super.applyLatestChanges(
      delta,
      prevElements,
      nextElements,
      modifierOptions,
    ) as HistoryDelta;
  }
}

export class HistoryChangedEvent {
  constructor(
    public readonly isUndoStackEmpty: boolean = true,
    public readonly isRedoStackEmpty: boolean = true,
  ) {}
}

export const HISTORY_MAX_ENTRIES = 200;
export const HISTORY_MAX_BYTES = 64 * 1024 * 1024;

export type HistoryOptions = {
  maxEntries?: number;
  maxBytes?: number;
};

const estimateValueBytes = (value: unknown, seen: Set<object>): number => {
  if (value === null || value === undefined) {
    return 8;
  }

  switch (typeof value) {
    case "boolean":
      return 4;
    case "number":
      return 8;
    case "bigint":
      return 16;
    case "string":
      return 16 + value.length * 2;
    case "function":
    case "symbol":
      return 8;
    case "object":
      break;
    default:
      return 8;
  }

  if (seen.has(value)) {
    return 0;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    let bytes = 24 + value.length * 8;
    for (const item of value) {
      bytes += estimateValueBytes(item, seen);
    }
    return bytes;
  }

  let bytes = 32;
  for (const [key, nestedValue] of Object.entries(value)) {
    bytes += 16 + key.length * 2 + estimateValueBytes(nestedValue, seen);
  }
  return bytes;
};

/**
 * Estimates the retained JS object graph for a history delta.
 *
 * This is intentionally a conservative approximation that avoids serializing
 * the full delta. It is used to keep history bounded, not as an exact browser
 * heap measurement.
 */
export const estimateHistoryDeltaBytes = (delta: HistoryDelta) =>
  estimateValueBytes(delta, new Set<object>());

export class History {
  public readonly onHistoryChangedEmitter = new Emitter<
    [HistoryChangedEvent]
  >();

  public readonly undoStack: HistoryDelta[] = [];
  public readonly redoStack: HistoryDelta[] = [];

  private undoEstimatedBytes = 0;
  private redoEstimatedBytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  public get isUndoStackEmpty() {
    return this.undoStack.length === 0;
  }

  public get isRedoStackEmpty() {
    return this.redoStack.length === 0;
  }

  constructor(
    private readonly store: Store,
    options: HistoryOptions = {},
  ) {
    this.maxEntries = Math.max(
      1,
      Math.trunc(options.maxEntries ?? HISTORY_MAX_ENTRIES),
    );
    this.maxBytes = Math.max(1, Math.trunc(options.maxBytes ?? HISTORY_MAX_BYTES));
  }

  public clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.undoEstimatedBytes = 0;
    this.redoEstimatedBytes = 0;
  }

  public getMemoryStats() {
    return {
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length,
      undoEstimatedBytes: this.undoEstimatedBytes,
      redoEstimatedBytes: this.redoEstimatedBytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
    };
  }

  /** Returns file ids retained by undo/redo entries. */
  public getReferencedFileIds(): ReadonlySet<FileId> {
    const fileIds = new Set<FileId>();

    for (const historyDelta of [...this.undoStack, ...this.redoStack]) {
      for (const delta of [
        historyDelta.elements.added,
        historyDelta.elements.removed,
        historyDelta.elements.updated,
      ]) {
        for (const elementDelta of Object.values(delta)) {
          for (const partial of [
            elementDelta.deleted,
            elementDelta.inserted,
          ]) {
            const fileId = (partial as { fileId?: unknown }).fileId;
            if (typeof fileId === "string") {
              fileIds.add(fileId as FileId);
            }
          }
        }
      }
    }

    return fileIds;
  }

  /**
   * Record a non-empty local durable increment, which will go into the undo stack..
   * Do not re-record history entries, which were already pushed to undo / redo stack, as part of history action.
   */
  public record(delta: StoreDelta) {
    if (delta.isEmpty() || delta instanceof HistoryDelta) {
      return;
    }

    // construct history entry, so once it's emitted, it's not recorded again
    const historyDelta = HistoryDelta.inverse(delta);

    this.pushEntry(this.undoStack, "undo", historyDelta);

    if (!historyDelta.elements.isEmpty()) {
      // don't reset redo stack on local appState changes,
      // as a simple click (unselect) could lead to losing all the redo entries
      // only reset on non empty elements changes!
      this.redoStack.length = 0;
      this.redoEstimatedBytes = 0;
    }

    this.onHistoryChangedEmitter.trigger(
      new HistoryChangedEvent(this.isUndoStackEmpty, this.isRedoStackEmpty),
    );
  }

  public undo(elements: SceneElementsMap, appState: AppState) {
    return this.perform(
      elements,
      appState,
      () => this.popEntry(this.undoStack, "undo"),
      (entry: HistoryDelta) => this.pushInverse(this.redoStack, "redo", entry),
    );
  }

  public redo(elements: SceneElementsMap, appState: AppState) {
    return this.perform(
      elements,
      appState,
      () => this.popEntry(this.redoStack, "redo"),
      (entry: HistoryDelta) => this.pushInverse(this.undoStack, "undo", entry),
    );
  }

  private perform(
    elements: SceneElementsMap,
    appState: AppState,
    pop: () => HistoryDelta | null,
    push: (entry: HistoryDelta) => void,
  ): [SceneElementsMap, AppState] | void {
    try {
      let historyDelta = pop();

      if (historyDelta === null) {
        return;
      }

      const action = CaptureUpdateAction.IMMEDIATELY;

      let prevSnapshot = this.store.snapshot;

      let nextElements = elements;
      let nextAppState = appState;
      let containsVisibleChange = false;

      // iterate through the history entries in case they result in no visible changes
      while (historyDelta) {
        try {
          [nextElements, nextAppState, containsVisibleChange] =
            historyDelta.applyTo(nextElements, nextAppState, prevSnapshot);

          const prevElements = prevSnapshot.elements;
          const nextSnapshot = prevSnapshot.maybeClone(
            action,
            nextElements,
            nextAppState,
          );

          const change = StoreChange.create(prevSnapshot, nextSnapshot);
          const delta = HistoryDelta.applyLatestChanges(
            historyDelta,
            prevElements,
            nextElements,
          );

          if (!delta.isEmpty()) {
            // schedule immediate capture, so that it's emitted for the sync purposes
            this.store.scheduleMicroAction({
              action,
              change,
              delta,
            });

            historyDelta = delta;
          }

          prevSnapshot = nextSnapshot;
        } finally {
          push(historyDelta);
        }

        if (containsVisibleChange) {
          break;
        }

        historyDelta = pop();
      }

      return [nextElements, nextAppState];
    } finally {
      // trigger the history change event before returning completely
      // also trigger it just once, no need doing so on each entry
      this.onHistoryChangedEmitter.trigger(
        new HistoryChangedEvent(this.isUndoStackEmpty, this.isRedoStackEmpty),
      );
    }
  }

  private popEntry(
    stack: HistoryDelta[],
    stackName: "undo" | "redo",
  ): HistoryDelta | null {
    if (!stack.length) {
      return null;
    }

    const entry = stack.pop();

    if (entry !== undefined) {
      this.updateStackBytes(stackName, -estimateHistoryDeltaBytes(entry));
      return entry;
    }

    return null;
  }

  private pushInverse(
    stack: HistoryDelta[],
    stackName: "undo" | "redo",
    entry: HistoryDelta,
  ) {
    const inversedEntry = HistoryDelta.inverse(entry);
    this.pushEntry(stack, stackName, inversedEntry);
  }

  private pushEntry(
    stack: HistoryDelta[],
    stackName: "undo" | "redo",
    entry: HistoryDelta,
  ) {
    stack.push(entry);
    this.updateStackBytes(stackName, estimateHistoryDeltaBytes(entry));
    this.trimStack(stack, stackName);
  }

  private updateStackBytes(stackName: "undo" | "redo", delta: number) {
    if (stackName === "undo") {
      this.undoEstimatedBytes = Math.max(0, this.undoEstimatedBytes + delta);
    } else {
      this.redoEstimatedBytes = Math.max(0, this.redoEstimatedBytes + delta);
    }
  }

  private trimStack(stack: HistoryDelta[], stackName: "undo" | "redo") {
    const getBytes = () =>
      stackName === "undo" ? this.undoEstimatedBytes : this.redoEstimatedBytes;

    // Keep one oversized entry so the most recent large operation remains
    // undoable, but discard older entries until the configured budget is met.
    while (
      stack.length > 1 &&
      (stack.length > this.maxEntries || getBytes() > this.maxBytes)
    ) {
      const oldest = stack.shift();
      if (oldest) {
        this.updateStackBytes(
          stackName,
          -estimateHistoryDeltaBytes(oldest),
        );
      }
    }
  }
}
