import * as MermaidToExcalidraw from "@excalidraw/mermaid-to-excalidraw";
import React from "react";
import { vi } from "bun:test";

import type { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import type { throttleRAF as throttleRAFType } from "@excalidraw/common";

type ThrottledFn<T extends unknown[]> = ((...args: T) => void) & {
  flush: () => void;
  cancel: () => void;
};

export const mockThrottleRAF: typeof throttleRAFType = <T extends unknown[]>(
  fn: (...args: T) => void,
) => {
  const ret = ((...args: T) => {
    fn(...args);
  }) as ThrottledFn<T>;

  ret.flush = () => {};
  ret.cancel = () => {};

  return ret;
};

export const mockMermaidToExcalidraw = (opts: {
  parseMermaidToExcalidraw: typeof parseMermaidToExcalidraw;
  mockRef?: boolean;
}) => {
  const parseMermaidToExcalidrawSpy = vi.spyOn(
    MermaidToExcalidraw,
    "parseMermaidToExcalidraw",
  );

  parseMermaidToExcalidrawSpy.mockImplementation(opts.parseMermaidToExcalidraw);

  if (opts.mockRef) {
    vi.spyOn(React, "useRef").mockReturnValue({
      current: {
        parseMermaidToExcalidraw: parseMermaidToExcalidrawSpy,
      },
    });
  }
};

let originalImageDescriptor: PropertyDescriptor | undefined;

const restoreImage = () => {
  if (originalImageDescriptor) {
    Object.defineProperty(globalThis, "Image", originalImageDescriptor);
    originalImageDescriptor = undefined;
  } else {
    delete (globalThis as { Image?: unknown }).Image;
  }
};

export const restoreMockHTMLImageElement = restoreImage;

// Mock for HTMLImageElement.
// as jsdom.resources: "usable" throws an error on image load
export const mockHTMLImageElement = (
  naturalWidth: number,
  naturalHeight: number,
) => {
  restoreImage();
  originalImageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Image",
  );
  const OriginalImage = window.Image;
  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    writable: true,
    value: class extends OriginalImage {
      constructor() {
        super();

        Object.defineProperty(this, "naturalWidth", {
          value: naturalWidth,
        });
        Object.defineProperty(this, "naturalHeight", {
          value: naturalHeight,
        });

        queueMicrotask(() => {
          this.onload?.({} as Event);
        });
      }
    },
  });
};

// Mocks for multiple HTMLImageElements (dimensions are assigned in the order of image initialization)
export const mockMultipleHTMLImageElements = (
  sizes: (readonly [number, number])[],
) => {
  const _sizes = [...sizes];

  restoreImage();
  originalImageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Image",
  );
  const OriginalImage = window.Image;
  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    writable: true,
    value: class extends OriginalImage {
      constructor() {
        super();

        const size = _sizes.shift();
        if (!size) {
          throw new Error("Insufficient sizes");
        }

        Object.defineProperty(this, "naturalWidth", {
          value: size[0],
        });
        Object.defineProperty(this, "naturalHeight", {
          value: size[1],
        });

        queueMicrotask(() => {
          this.onload?.({} as Event);
        });
      }
    },
  });
};
