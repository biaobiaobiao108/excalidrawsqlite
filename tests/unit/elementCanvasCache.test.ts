import { describe, expect, it } from "bun:test";

import { ElementCanvasCache } from "../../packages/element/src/elementCanvasCache";

const raster = (width = 5, height = 5) => ({ canvas: { width, height } });

describe("element canvas cache", () => {
  it("evicts the least recently used raster and releases its pixels", () => {
    const cache = new ElementCanvasCache<object, ReturnType<typeof raster>>(50);
    const owner = {};
    const a = {}, b = {}, c = {};
    const first = raster(), second = raster();
    cache.set(a, first, owner);
    cache.set(b, second, owner);
    expect(cache.get(a, owner)).toBe(first);
    cache.set(c, raster(), owner);
    expect(cache.get(b, owner)).toBeUndefined();
    expect(second.canvas).toEqual({ width: 0, height: 0 });
    expect(cache.getMemoryStats(owner)).toEqual({ entries: 2, pixels: 50 });
  });

  it("bounds retained canvases while traversing a large scene", () => {
    const cache = new ElementCanvasCache<object, ReturnType<typeof raster>>(50);
    const owner = {};
    const scene = Array.from({ length: 1000 }, () => ({}));
    const values = scene.map(() => raster());
    scene.forEach((element, index) => cache.set(element, values[index], owner));
    expect(cache.getMemoryStats(owner)).toEqual({ entries: 2, pixels: 50 });
    expect(values.slice(0, -2).every((entry) => entry.canvas.width === 0)).toBe(true);
  });

  it("bounds entry count even for tiny rasters", () => {
    const cache = new ElementCanvasCache<object, ReturnType<typeof raster>>(100, 2);
    const owner = {};
    for (let index = 0; index < 10; index++) {
      cache.set({}, raster(1, 1), owner);
    }
    expect(cache.getMemoryStats(owner)).toEqual({ entries: 2, pixels: 2 });
  });

  it("clears one editor without invalidating another editor", () => {
    const cache = new ElementCanvasCache<object, ReturnType<typeof raster>>(50);
    const firstOwner = {}, secondOwner = {}, element = {};
    const first = raster(), second = raster();
    cache.set(element, first, firstOwner);
    cache.set(element, second, secondOwner);
    cache.clear(firstOwner);
    expect(first.canvas.width).toBe(0);
    expect(cache.getMemoryStats(firstOwner).pixels).toBe(0);
    expect(cache.get(element, secondOwner)).toBe(second);
    expect(second.canvas.width).toBe(5);
    cache.delete(element);
    expect(second.canvas.width).toBe(0);
    expect(cache.getMemoryStats(secondOwner).entries).toBe(0);
  });

  it("invalidates all cached versions when an element changes", () => {
    const cache = new ElementCanvasCache<object, ReturnType<typeof raster>>(50);
    const firstOwner = {}, secondOwner = {}, element = {};
    const first = raster(), second = raster();
    cache.set(element, first, firstOwner);
    cache.set(element, second, secondOwner);
    cache.delete(element);
    expect(first.canvas.width).toBe(0);
    expect(second.canvas.width).toBe(0);
    expect(cache.getMemoryStats(firstOwner).pixels).toBe(0);
    expect(cache.getMemoryStats(secondOwner).pixels).toBe(0);
  });

  it("keeps an oversized draw intact until it is drawn, then releases it", () => {
    const cache = new ElementCanvasCache<object, ReturnType<typeof raster>>(20);
    const owner = {}, element = {};
    const oversized = raster();
    cache.set(element, oversized, owner);
    expect(oversized.canvas.width).toBe(5);
    expect(cache.get(element, owner)).toBeUndefined();
    cache.releaseUncached(element, oversized, owner);
    expect(oversized.canvas.width).toBe(0);
  });
});
