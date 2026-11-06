import { describe, expect, it } from "bun:test";
import { newElement } from "../../packages/element/src/newElement";
const originalDocument = Object.getOwnPropertyDescriptor(
  globalThis,
  "document",
);
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const fakeWindow = { devicePixelRatio: 1, navigator: { userAgent: "test" } };
Object.defineProperties(globalThis, {
  document: {
    configurable: true,
    value: {
      createElement: () => ({
        style: {},
        getContext: () => ({}),
        setAttribute() {},
      }),
      createElementNS: () => ({
        setAttribute() {},
        appendChild() {},
        removeChild() {},
      }),
      defaultView: fakeWindow,
    },
  },
  window: { configurable: true, value: fakeWindow },
});
const { Renderer } = await import("../../packages/excalidraw/scene/Renderer");
if (originalDocument)
  Object.defineProperty(globalThis, "document", originalDocument);
else Reflect.deleteProperty(globalThis, "document");
if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
else Reflect.deleteProperty(globalThis, "window");

describe("renderer visible index", () => {
  it("updates moved and replaced elements and rebuilds on reorder", () => {
    const renderer = new Renderer({} as any) as any;
    const a = newElement({
      type: "rectangle",
      x: 0,
      y: 0,
      width: 20,
      height: 20,
    });
    const b = newElement({
      type: "rectangle",
      x: 3000,
      y: 0,
      width: 20,
      height: 20,
    });
    const map = (...elements: any[]) =>
      new Map(elements.map((element) => [element.id, element]));
    const visible = (
      elements: Map<string, any>,
      bounds: [number, number, number, number],
    ) => renderer.getVisibleElementCandidates(elements, bounds);
    expect(visible(map(a, b), [0, 0, 100, 100])).toEqual([a]);
    const buckets = renderer.visibleElementIndex.buckets;
    const moved = { ...b, x: 50, version: b.version + 1 };
    expect(visible(map(a, moved), [0, 0, 100, 100])).toEqual([a, moved]);
    expect(renderer.visibleElementIndex.buckets).toBe(buckets);
    const replacement = { ...a, version: a.version + 1 };
    expect(visible(map(replacement, moved), [0, 0, 100, 100])).toEqual([
      replacement,
      moved,
    ]);
    moved.x = 5000;
    moved.version += 1;
    expect(visible(map(replacement, moved), [0, 0, 100, 100])).toEqual([
      replacement,
    ]);
    moved.x = 50;
    moved.version += 1;
    expect(visible(map(replacement, moved), [0, 0, 100, 100])).toEqual([
      replacement,
      moved,
    ]);
    expect(visible(map(moved, replacement), [0, 0, 100, 100])).toEqual([
      moved,
      replacement,
    ]);
    expect(renderer.visibleElementIndex.buckets).not.toBe(buckets);
    renderer.destroy();
  });

  it("moves elements between large-element and grid buckets", () => {
    const renderer = new Renderer({} as any) as any;
    const large = newElement({
      type: "rectangle",
      x: 0,
      y: 0,
      width: 300000,
      height: 1000,
    });
    const map = (element: any) => new Map([[element.id, element]]);
    const candidates = (element: any) =>
      renderer.getVisibleElementCandidates(map(element), [0, 0, 100, 100]);
    expect(candidates(large)).toEqual([large]);
    expect(renderer.visibleElementIndex.largeElements).toHaveLength(1);
    const small = {
      ...large,
      width: 10,
      height: 10,
      version: large.version + 1,
    };
    expect(candidates(small)).toEqual([small]);
    expect(renderer.visibleElementIndex.largeElements).toHaveLength(0);
    const largeAgain = {
      ...small,
      width: 300000,
      height: 1000,
      version: small.version + 1,
    };
    expect(candidates(largeAgain)).toEqual([largeAgain]);
    expect(renderer.visibleElementIndex.largeElements).toHaveLength(1);
    renderer.destroy();
  });
});
