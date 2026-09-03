import fs from "fs";
import { JSDOM } from "jsdom";

if (typeof window === "undefined") {
  const dom = new JSDOM("<!DOCTYPE html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const win = dom.window as any;
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.navigator = win.navigator;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.HTMLCanvasElement = win.HTMLCanvasElement;
  globalThis.Node = win.Node;
  globalThis.Element = win.Element;
  globalThis.Event = win.Event;
  globalThis.CustomEvent = win.CustomEvent;
  globalThis.DOMParser = win.DOMParser;
  globalThis.XMLSerializer = win.XMLSerializer;
  globalThis.requestAnimationFrame = (cb: any) => setTimeout(cb, 16) as any;
  globalThis.cancelAnimationFrame = (id: any) => clearTimeout(id);
}

// setupTests.ts
import { assert } from "chai";
(globalThis as any).assert = assert;
import { setupCanvasMock } from "./packages/excalidraw/tests/canvas-mock-shim";
setupCanvasMock(globalThis);
import "@testing-library/jest-dom";
import { configure } from "@testing-library/react";
import { vi } from "./packages/excalidraw/tests/vitest-shim";

import { mockThrottleRAF } from "./packages/excalidraw/tests/helpers/mocks";
import { yellow } from "./packages/excalidraw/tests/helpers/colorize";
import {
  PolyfillLocalStorage,
  testPolyfills,
} from "./packages/excalidraw/tests/helpers/polyfills";

Object.assign(globalThis, testPolyfills);
PolyfillLocalStorage();

// By default testing-library dumps the entire serialized DOM into the error
// message whenever a `waitFor`/`getBy*` fails, which floods the test output
// (often hundreds of lines of HTML per failure). Strip it out unless
// VITE_DEBUG_DOM is enabled (see .env.test), e.g. `VITE_DEBUG_DOM=true bun test`.
const debugDom = ["true", "1"].includes(process.env.VITE_DEBUG_DOM ?? "");
if (!debugDom) {
  configure({
    getElementError: (message) => {
      const error = new Error(message ?? undefined);
      error.name = "TestingLibraryElementError";
      return error;
    },
  });
}

import * as commonModule from "./packages/common/src/index";
import { mock } from "bun:test";

mock.module("@excalidraw/common", () => ({
  ...commonModule,
  throttleRAF: mockThrottleRAF,
}));

// mock for pep.js not working with setPointerCapture()
HTMLElement.prototype.setPointerCapture = vi.fn();

require("fake-indexeddb/auto");

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

Object.defineProperty(window, "FontFace", {
  enumerable: true,
  value: class {
    private family: string;
    private source: string;
    private descriptors: any;
    private status: string;
    private unicodeRange: string;

    constructor(family, source, descriptors) {
      this.family = family;
      this.source = source;
      this.descriptors = descriptors;
      this.status = "unloaded";
      this.unicodeRange = "U+0000-00FF";
    }

    load() {
      this.status = "loaded";
    }
  },
});

Object.defineProperty(document, "fonts", {
  value: {
    load: vi.fn().mockResolvedValue([]),
    check: vi.fn().mockResolvedValue(true),
    has: vi.fn().mockResolvedValue(true),
    add: vi.fn(),
  },
});

Object.defineProperty(window, "EXCALIDRAW_ASSET_PATH", {
  value: `file://${__dirname}/`,
});

// mock the font fetch only, so that everything else, as font subsetting, can run inside of the (snapshot) tests
import * as fontFaceModule from "./packages/excalidraw/fonts/ExcalidrawFontFace";

mock.module("./packages/excalidraw/fonts/ExcalidrawFontFace", () => {
  const ExcalidrawFontFaceImpl = fontFaceModule.ExcalidrawFontFace;
  return {
    ...fontFaceModule,
    ExcalidrawFontFace: class extends ExcalidrawFontFaceImpl {
      public async fetchFont(url: URL): Promise<ArrayBuffer> {
        if (!url.toString().startsWith("file://")) {
          return super.fetchFont(url);
        }

        // read local assets directly, without running a server
        const content = await fs.promises.readFile(url);
        return content.buffer;
      }
    },
  };
});

// ReactDOM is located inside index.tsx file
// as a result, we need a place for it to render into
const element = document.createElement("div");
element.id = "root";
document.body.appendChild(element);

const _consoleError = console.error.bind(console);
console.error = (...args) => {
  // the react's act() warning usually doesn't contain any useful stack trace
  // so we're catching the log and re-logging the message with the test name,
  // also stripping the actual component stack trace as it's not useful
  if (args[0]?.includes?.("act(")) {
    _consoleError(
      yellow(
        `<<< WARNING: test "${
          expect.getState().currentTestName
        }" does not wrap some state update in act() >>>`,
      ),
    );
  } else {
    _consoleError(...args);
  }
};
