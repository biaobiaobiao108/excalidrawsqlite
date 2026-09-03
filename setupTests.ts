import fs from "fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect as bunExpect,
  it,
  vi,
  mock,
  test,
} from "bun:test";
import { assert } from "chai";
import { mockThrottleRAF } from "./packages/excalidraw/tests/helpers/mocks";
import { yellow } from "./packages/excalidraw/tests/helpers/colorize";
import {
  PolyfillLocalStorage,
  testPolyfills,
} from "./packages/excalidraw/tests/helpers/polyfills";

process.env.NODE_ENV = "test";
process.env.RTL_SKIP_AUTO_CLEANUP = "true";

Object.assign(globalThis, {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect: bunExpect,
  it,
  test,
});

if (typeof window === "undefined") {
  const dom = new JSDOM("<!DOCTYPE html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const win = dom.window as any;
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.navigator = win.navigator;
  globalThis.location = win.location;
  globalThis.history = win.history;
  (globalThis as any).devicePixelRatio = win.devicePixelRatio || 1;
  (globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.HTMLElement = win.HTMLElement;
  (globalThis as any).HTMLDivElement = win.HTMLDivElement;
  (globalThis as any).HTMLInputElement = win.HTMLInputElement;
  (globalThis as any).HTMLTextAreaElement = win.HTMLTextAreaElement;
  (globalThis as any).HTMLSelectElement = win.HTMLSelectElement;
  (globalThis as any).HTMLButtonElement = win.HTMLButtonElement;
  (globalThis as any).HTMLImageElement = win.HTMLImageElement;
  (globalThis as any).HTMLAnchorElement = win.HTMLAnchorElement;
  (globalThis as any).HTMLIFrameElement = win.HTMLIFrameElement;
  (globalThis as any).SVGElement = win.SVGElement;
  globalThis.HTMLCanvasElement = win.HTMLCanvasElement;
  globalThis.Blob = win.Blob;
  (globalThis as any).File = win.File;
  (globalThis as any).FileReader = win.FileReader;
  globalThis.Node = win.Node;
  (globalThis as any).NodeFilter = win.NodeFilter;
  globalThis.Element = win.Element;
  globalThis.Event = win.Event;
  globalThis.CustomEvent = win.CustomEvent;
  (globalThis as any).MouseEvent = win.MouseEvent;
  (globalThis as any).KeyboardEvent = win.KeyboardEvent;
  (globalThis as any).FocusEvent = win.FocusEvent;
  (globalThis as any).WheelEvent = win.WheelEvent;
  (globalThis as any).Range = win.Range;
  (globalThis as any).Selection = win.Selection;
  globalThis.DOMParser = win.DOMParser;
  globalThis.XMLSerializer = win.XMLSerializer;
  // Font subsetting is intentionally exercised on Bun's main thread. Bun's
  // Worker implementation is available in tests but cannot load browser
  // bundle URLs, which would make export tests hang instead of falling back.
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: undefined,
  });
  class Path2DImpl {
    constructor(public readonly path?: string) {}
  }
  (globalThis as any).Path2D = Path2DImpl;
  win.Path2D = Path2DImpl;
  globalThis.requestAnimationFrame = (cb: any) => setTimeout(cb, 16) as any;
  globalThis.cancelAnimationFrame = (id: any) => clearTimeout(id);
  win.setTimeout = globalThis.setTimeout.bind(globalThis);
  win.clearTimeout = globalThis.clearTimeout.bind(globalThis);
  win.setInterval = globalThis.setInterval.bind(globalThis);
  win.clearInterval = globalThis.clearInterval.bind(globalThis);
}

(globalThis as any).assert = assert;
const { setupCanvasMock } = await import(
  "./packages/excalidraw/tests/canvas-mock-shim"
);
setupCanvasMock(globalThis);
await import("@testing-library/jest-dom");
const { configure } = await import("@testing-library/react");

Object.assign(globalThis, testPolyfills);
PolyfillLocalStorage();
(globalThis as any).localStorage = window.localStorage;
(globalThis as any).sessionStorage = window.sessionStorage;

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

const commonModule = await import("./packages/common/src/index");

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

const FontFaceImpl = class {
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
};

Object.defineProperty(window, "FontFace", {
  enumerable: true,
  value: FontFaceImpl,
});
(globalThis as any).FontFace = FontFaceImpl;

Object.defineProperty(document, "fonts", {
  value: {
    load: vi.fn().mockResolvedValue([]),
    check: vi.fn().mockResolvedValue(true),
    has: vi.fn().mockResolvedValue(true),
    add: vi.fn(),
  },
});

Object.defineProperty(window, "EXCALIDRAW_ASSET_PATH", {
  value: pathToFileURL(`${__dirname}/`).toString(),
});

// Bun's fetch does not serve file URLs. Keep the production font-loading path
// intact and intercept only local test assets at the fetch boundary.
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input, init) => {
  const url =
    input instanceof URL
      ? input
      : new URL(typeof input === "string" ? input : input.url);

  if (url.protocol === "file:") {
    const content = await fs.promises.readFile(fileURLToPath(url));
    return new Response(content, { status: 200 });
  }

  return nativeFetch(input, init);
}) as typeof fetch;

// ReactDOM is located inside index.tsx file
// as a result, we need a place for it to render into
const element = document.createElement("div");
element.id = "root";
document.body.appendChild(element);

const _consoleError = console.error.bind(console);
console.error = (...args) => {
  // the react's act() warning usually doesn't contain any useful stack trace
  // so we're catching the log and re-logging a concise warning without the
  // actual component stack trace, which is not useful here
  if (args[0]?.includes?.("act(")) {
    _consoleError(yellow("<<< WARNING: some state update was not wrapped in act() >>>"));
  } else {
    _consoleError(...args);
  }
};
