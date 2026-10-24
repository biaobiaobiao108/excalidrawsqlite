type CanvasEntry = {
  canvas: { width: number; height: number };
};

/** Editor-only raster cache. Exports never enter this cache. */
export class ElementCanvasCache<K extends object, V extends CanvasEntry> {
  private readonly owners = new WeakMap<object, Map<K, V>>();
  private readonly references = new WeakMap<K, Set<Map<K, V>>>();
  private readonly pixels = new WeakMap<Map<K, V>, number>();

  constructor(
    private readonly maxPixels = 16_000_000,
    private readonly maxEntries = 512,
  ) {}

  get(key: K, owner: object): V | undefined {
    const entries = this.owners.get(owner);
    const entry = entries?.get(key);
    if (entry) {
      entries!.delete(key);
      entries!.set(key, entry);
    }
    return entry;
  }

  set(key: K, value: V, owner: object, maxPixels = this.maxPixels) {
    let entries = this.owners.get(owner);
    if (!entries) {
      entries = new Map();
      this.owners.set(owner, entries);
    }
    if (entries.has(key)) {
      this.remove(entries, key);
    }
    const size = value.canvas.width * value.canvas.height;
    // A single oversized raster is used for this draw, but not retained.
    // Its caller releases it after drawing via releaseUncached().
    if (size > maxPixels) {
      return;
    }
    while (
      entries.size &&
      ((this.pixels.get(entries) || 0) + size > maxPixels ||
        entries.size >= this.maxEntries)
    ) {
      this.remove(entries, entries.keys().next().value!);
    }
    entries.set(key, value);
    this.pixels.set(entries, (this.pixels.get(entries) || 0) + size);
    let references = this.references.get(key);
    if (!references) {
      references = new Set();
      this.references.set(key, references);
    }
    references.add(entries);
  }

  delete(key: K) {
    const references = this.references.get(key);
    if (references) {
      for (const entries of [...references]) {
        this.remove(entries, key);
      }
    }
  }

  clear(owner: object) {
    const entries = this.owners.get(owner);
    if (entries) {
      for (const key of [...entries.keys()]) {
        this.remove(entries, key);
      }
      this.owners.delete(owner);
    }
  }

  releaseUncached(key: K, value: V, owner: object) {
    if (this.owners.get(owner)?.get(key) !== value) {
      this.release(value);
    }
  }

  getMemoryStats(owner: object) {
    const entries = this.owners.get(owner);
    return {
      entries: entries?.size || 0,
      pixels: entries ? this.pixels.get(entries) || 0 : 0,
    };
  }

  private remove(entries: Map<K, V>, key: K) {
    const value = entries.get(key);
    if (!value) {
      return;
    }
    this.pixels.set(
      entries,
      (this.pixels.get(entries) || 0) -
        value.canvas.width * value.canvas.height,
    );
    entries.delete(key);
    this.references.get(key)?.delete(entries);
    this.release(value);
  }

  private release(value: V) {
    value.canvas.width = 0;
    value.canvas.height = 0;
  }
}
