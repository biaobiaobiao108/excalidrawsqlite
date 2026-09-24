import { describe, expect, it } from "bun:test";

import { AppStateDelta, ElementsDelta, Delta } from "../../packages/element/src/delta";
import { StoreDelta } from "../../packages/element/src/store";
import type { Store } from "../../packages/element/src/store";
import type { FileId } from "../../packages/element/src/types";
import { getDeviceMemoryTier } from "../../packages/common/src/deviceMemory";
import {
  HISTORY_MAX_BYTES,
  HISTORY_MAX_ENTRIES,
  History,
} from "../../packages/excalidraw/history";
import { ImageCache } from "../../packages/excalidraw/imageCache";
import {
  getEditorCanvasPixelBudget,
  getEditorRenderScale,
} from "../../packages/excalidraw/renderScale";
import { BodyMemoryBudget } from "../../server/types";

const observedAppState = (name: string) => ({
  name,
  viewBackgroundColor: "#ffffff",
  editingGroupId: null,
  selectedElementIds: {},
  selectedGroupIds: {},
  selectedLinearElement: null,
  croppingElementId: null,
  activeLockedId: null,
  lockedMultiSelections: {},
});

const appStateDelta = (previousName: string, nextName: string) =>
  StoreDelta.create(
    ElementsDelta.empty(),
    AppStateDelta.calculate(
      observedAppState(previousName),
      observedAppState(nextName),
    ),
  );

const imageEntry = (width: number, height: number) =>
  ({
    image: {
      naturalWidth: width,
      naturalHeight: height,
      width,
      height,
    } as HTMLImageElement,
    mimeType: "image/png",
  }) as const;

const fileId = (value: string) => value as FileId;

describe("memory budgets", () => {
  it("uses a bounded middle tier when the browser hides device memory", () => {
    expect(getDeviceMemoryTier(undefined, "Mozilla/5.0 Macintosh Safari/627.1"))
      .toBe("unknown");
    expect(getEditorCanvasPixelBudget(undefined, "Mozilla/5.0 Macintosh Safari/627.1"))
      .toBe(24_000_000);
    expect(getDeviceMemoryTier(8, "Mozilla/5.0 Macintosh Safari/627.1"))
      .toBe("standard");
    expect(getDeviceMemoryTier(4, "Mozilla/5.0 Macintosh Safari/627.1"))
      .toBe("low");
    expect(getDeviceMemoryTier(undefined, "Mozilla/5.0 iPhone Mobile"))
      .toBe("low");
  });

  it("uses the middle editor scale for desktop browsers without memory data", () => {
    const unknownMemoryScale = getEditorRenderScale({
      width: 3840,
      height: 2160,
      devicePixelRatio: 2,
      canvasCount: 3,
      userAgent: "Mozilla/5.0 Macintosh Safari/627.1",
    });
    const standardScale = getEditorRenderScale({
      width: 3840,
      height: 2160,
      devicePixelRatio: 2,
      canvasCount: 3,
      deviceMemory: 8,
      userAgent: "Mozilla/5.0 Macintosh Safari/627.1",
    });

    expect(unknownMemoryScale).toBeLessThan(standardScale);
    expect(unknownMemoryScale).toBeGreaterThan(0.5);
  });

  it("bounds history by entry count and tracks estimated bytes", () => {
    const history = new History({} as Store, { maxEntries: 2 });

    history.record(appStateDelta("one", "two"));
    history.record(appStateDelta("two", "three"));
    history.record(appStateDelta("three", "four"));

    expect(history.undoStack).toHaveLength(2);
    expect(history.getMemoryStats()).toMatchObject({
      undoCount: 2,
      redoCount: 0,
      maxEntries: 2,
      maxBytes: HISTORY_MAX_BYTES,
    });
    expect(history.getMemoryStats().undoEstimatedBytes).toBeGreaterThan(0);
  });

  it("keeps a single oversized history entry undoable", () => {
    const history = new History({} as Store, { maxBytes: 1 });

    history.record(appStateDelta("a", "a".repeat(2048)));

    expect(history.undoStack).toHaveLength(1);
    expect(history.getMemoryStats().undoEstimatedBytes).toBeGreaterThan(1);
  });

  it("retains file ids referenced by history deltas", () => {
    const elementDelta = Delta.create<any>(
      { isDeleted: true, version: 0, versionNonce: 1 },
      {
        isDeleted: false,
        type: "image",
        fileId: fileId("file-a"),
        version: 1,
        versionNonce: 2,
      },
    );
    const history = new History({} as Store);

    history.record(
      StoreDelta.create(
        ElementsDelta.create({ "element-a": elementDelta as any }, {}, {}),
        AppStateDelta.empty(),
      ),
    );

    expect([...history.getReferencedFileIds()]).toEqual([fileId("file-a")]);
  });

  it("evicts the least recently used decoded image", () => {
    const cache = new ImageCache(272);

    cache.set(fileId("image-a"), imageEntry(8, 8));
    cache.set(fileId("image-b"), imageEntry(2, 2));
    cache.get(fileId("image-a"));
    cache.set(fileId("image-c"), imageEntry(2, 2));
    cache.trim();

    expect(cache.has(fileId("image-a"))).toBe(true);
    expect(cache.has(fileId("image-b"))).toBe(false);
    expect(cache.has(fileId("image-c"))).toBe(true);
    expect(cache.getMemoryStats().decodedBytes).toBe(272);
  });

  it("reduces editor render scale when the active canvas budget is exceeded", () => {
    const normalScale = getEditorRenderScale({
      width: 1920,
      height: 1080,
      devicePixelRatio: 2,
      canvasCount: 3,
      deviceMemory: 8,
    });
    const highDpiScale = getEditorRenderScale({
      width: 3840,
      height: 2160,
      devicePixelRatio: 2,
      canvasCount: 3,
      deviceMemory: 8,
    });
    const lowMemoryScale = getEditorRenderScale({
      width: 3840,
      height: 2160,
      devicePixelRatio: 2,
      canvasCount: 3,
      deviceMemory: 4,
    });

    expect(normalScale).toBe(2);
    expect(highDpiScale).toBeLessThan(2);
    expect(lowMemoryScale).toBeLessThan(highDpiScale);
  });

  it("blocks body readers until aggregate memory is released", async () => {
    const budget = new BodyMemoryBudget(10);
    const reserved = await budget.acquire(8);
    let waiterResolved = false;
    const waiter = budget.acquire(4).then(() => {
      waiterResolved = true;
    });

    await Promise.resolve();
    expect(waiterResolved).toBe(false);

    budget.release(reserved);
    await waiter;
    expect(waiterResolved).toBe(true);
    expect(budget.getStats()).toMatchObject({
      availableBytes: 6,
      currentBytes: 4,
      peakBytes: 8,
    });
    budget.release(4);
    expect(budget.getStats().availableBytes).toBe(10);
  });

  it("removes aborted body readers from the wait queue", async () => {
    const budget = new BodyMemoryBudget(4);
    const reserved = await budget.acquire(4);
    const controller = new AbortController();
    const waiter = budget.acquire(4, controller.signal);

    controller.abort();
    await expect(waiter).rejects.toMatchObject({ name: "AbortError" });
    expect(budget.getStats().queuedRequests).toBe(0);

    budget.release(reserved);
    expect(budget.getStats().availableBytes).toBe(4);
  });

  it("uses the documented history defaults", () => {
    const history = new History({} as Store);
    expect(history.getMemoryStats()).toMatchObject({
      maxEntries: HISTORY_MAX_ENTRIES,
      maxBytes: HISTORY_MAX_BYTES,
    });
  });
});
