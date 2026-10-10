import { describe, expect, it } from "bun:test";

import { updateImageCache } from "../../packages/element/src/image";
import type { BinaryFiles } from "../../packages/excalidraw/types";
import type { FileId } from "../../packages/element/src/types";
import { ImageCache } from "../../packages/excalidraw/imageCache";

const fileId = (value: string) => value as FileId;

describe("image decode memory budget", () => {
  it("limits concurrent decodes to the pending reservation budget", async () => {
    const originalImage = globalThis.Image;
    let activeDecodes = 0;
    let maxActiveDecodes = 0;
    let startedCount = 0;
    const waitingStarts: Array<() => void> = [];
    const pendingReleases: Array<() => void> = [];

    class ControlledImage {
      onload: ((this: GlobalEventHandlers, ev: Event) => any) | null = null;
      onerror: OnErrorEventHandler = null;
      naturalWidth = 10;
      naturalHeight = 10;
      width = 10;
      height = 10;

      set src(_value: string) {
        activeDecodes += 1;
        maxActiveDecodes = Math.max(maxActiveDecodes, activeDecodes);
        startedCount += 1;
        waitingStarts.splice(0).forEach((resolve) => resolve());
        pendingReleases.push(() => {
          activeDecodes -= 1;
          this.onload?.call(this as any, new Event("load"));
        });
      }
    }

    const waitForStarts = (count: number) =>
      startedCount >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => waitingStarts.push(resolve));

    globalThis.Image = ControlledImage as unknown as typeof Image;
    try {
      const cache = new ImageCache(6 * 1024 * 1024);
      const files = Object.fromEntries(
        ["one", "two", "three"].map((id) => [
          id,
          {
            id,
            mimeType: "image/png",
            dataURL: "data:image/png;base64,AA==",
          },
        ]),
      ) as unknown as BinaryFiles;
      const loading = updateImageCache({
        fileIds: [fileId("one"), fileId("two"), fileId("three")],
        files,
        imageCache: cache,
      });

      await waitForStarts(1);
      expect(cache.getMemoryStats()).toMatchObject({
        pendingDecodes: 1,
        pendingDecodeBytes: 4 * 1024 * 1024,
      });
      for (let count = 1; count <= 3; count += 1) {
        expect(maxActiveDecodes).toBe(1);
        pendingReleases.shift()?.();
        if (count < 3) {
          await waitForStarts(count + 1);
        }
      }
      await loading;
      expect(cache.getMemoryStats().pendingDecodes).toBe(0);
      expect(cache.size).toBe(3);
    } finally {
      globalThis.Image = originalImage;
    }
  });

  it("removes a rejected decode so its reservation is released and it can retry", async () => {
    const originalImage = globalThis.Image;
    let shouldReject = true;

    class RejectOnceImage {
      onload: ((this: GlobalEventHandlers, ev: Event) => any) | null = null;
      onerror: OnErrorEventHandler = null;
      naturalWidth = 10;
      naturalHeight = 10;
      width = 10;
      height = 10;

      set src(_value: string) {
        if (shouldReject) {
          shouldReject = false;
          queueMicrotask(() => this.onerror?.("decode failed", "", 0, 0));
          return;
        }
        queueMicrotask(() => this.onload?.call(this as any, new Event("load")));
      }
    }

    globalThis.Image = RejectOnceImage as unknown as typeof Image;
    try {
      const cache = new ImageCache(4 * 1024 * 1024);
      const files = {
        retry: {
          id: "retry",
          mimeType: "image/png",
          dataURL: "data:image/png;base64,AA==",
        },
      } as unknown as BinaryFiles;
      const options = {
        fileIds: [fileId("retry")],
        files,
        imageCache: cache,
      };

      const first = await updateImageCache(options);
      expect(first.erroredFiles.has(fileId("retry"))).toBe(true);
      expect(cache.has(fileId("retry"))).toBe(false);
      expect(cache.getMemoryStats().pendingDecodeBytes).toBe(0);

      const second = await updateImageCache(options);
      expect(second.erroredFiles.size).toBe(0);
      expect(cache.get(fileId("retry"))?.image).not.toBeInstanceOf(Promise);
      expect(cache.getMemoryStats().pendingDecodeBytes).toBe(0);
    } finally {
      globalThis.Image = originalImage;
    }
  });
});
