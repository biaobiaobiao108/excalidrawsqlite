import { getDeviceMemoryTier, IMAGE_MIME_TYPES } from "@excalidraw/common";

import type { ValueOf } from "@excalidraw/common/utility-types";
import type { FileId } from "@excalidraw/element/types";

export type ImageCacheEntry = {
  image: HTMLImageElement | Promise<HTMLImageElement>;
  mimeType: ValueOf<typeof IMAGE_MIME_TYPES>;
};

const BYTES_PER_DECODED_PIXEL = 4;
const DEFAULT_IMAGE_CACHE_BYTES = 128 * 1024 * 1024;
const UNKNOWN_MEMORY_IMAGE_CACHE_BYTES = 96 * 1024 * 1024;
const LOW_MEMORY_IMAGE_CACHE_BYTES = 64 * 1024 * 1024;

const getDeviceMemory = () =>
  typeof navigator === "undefined"
    ? undefined
    : (navigator as Navigator & { deviceMemory?: number }).deviceMemory;

export const isLowMemoryDevice = () => {
  const deviceMemory = getDeviceMemory();
  const userAgent =
    typeof navigator === "undefined" ? "" : navigator.userAgent;
  return getDeviceMemoryTier(deviceMemory, userAgent) === "low";
};

export const getDefaultImageCacheBytes = () => {
  const deviceMemory = getDeviceMemory();
  const userAgent =
    typeof navigator === "undefined" ? "" : navigator.userAgent;
  const memoryTier = getDeviceMemoryTier(deviceMemory, userAgent);
  return memoryTier === "low"
    ? LOW_MEMORY_IMAGE_CACHE_BYTES
    : memoryTier === "unknown"
      ? UNKNOWN_MEMORY_IMAGE_CACHE_BYTES
      : DEFAULT_IMAGE_CACHE_BYTES;
};

const getDecodedImageBytes = (entry: ImageCacheEntry) => {
  if (entry.image instanceof Promise) {
    return 0;
  }

  const width = entry.image.naturalWidth || entry.image.width;
  const height = entry.image.naturalHeight || entry.image.height;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return 0;
  }
  return Math.max(0, width * height * BYTES_PER_DECODED_PIXEL);
};

/**
 * Map-compatible image cache with a bounded decoded-pixel budget.
 *
 * The data URL remains in BinaryFiles, so evicting an entry only releases the
 * browser-decoded image and the next render can hydrate it again.
 */
export class ImageCache extends Map<FileId, ImageCacheEntry> {
  private readonly entryBytes = new Map<FileId, number>();
  private readonly lastUsed = new Map<FileId, number>();
  private pinnedFileIds = new Set<FileId>();
  private accessCounter = 0;
  private decodedBytes = 0;

  constructor(private readonly maxDecodedBytes = getDefaultImageCacheBytes()) {
    super();
  }

  override get(fileId: FileId) {
    const entry = super.get(fileId);
    if (entry) {
      this.lastUsed.set(fileId, ++this.accessCounter);
    }
    return entry;
  }

  override set(fileId: FileId, entry: ImageCacheEntry) {
    const previousBytes = this.entryBytes.get(fileId) || 0;
    this.decodedBytes -= previousBytes;
    super.set(fileId, entry);
    this.entryBytes.set(fileId, getDecodedImageBytes(entry));
    this.decodedBytes += this.entryBytes.get(fileId)!;
    this.lastUsed.set(fileId, ++this.accessCounter);
    return this;
  }

  override delete(fileId: FileId) {
    const deleted = super.delete(fileId);
    if (deleted) {
      this.decodedBytes -= this.entryBytes.get(fileId) || 0;
      this.entryBytes.delete(fileId);
      this.lastUsed.delete(fileId);
      this.pinnedFileIds.delete(fileId);
    }
    return deleted;
  }

  override clear() {
    super.clear();
    this.entryBytes.clear();
    this.lastUsed.clear();
    this.pinnedFileIds.clear();
    this.decodedBytes = 0;
  }

  public setPinnedFileIds(fileIds: Iterable<FileId>) {
    this.pinnedFileIds = new Set(fileIds);
    this.trim();
  }

  public trim() {
    while (this.decodedBytes > this.maxDecodedBytes) {
      let candidate: FileId | undefined;
      let candidateLastUsed = Number.POSITIVE_INFINITY;

      for (const [fileId, entry] of this.entries()) {
        if (
          this.pinnedFileIds.has(fileId) ||
          entry.image instanceof Promise ||
          (this.lastUsed.get(fileId) || 0) >= candidateLastUsed
        ) {
          continue;
        }
        candidate = fileId;
        candidateLastUsed = this.lastUsed.get(fileId) || 0;
      }

      if (!candidate) {
        return;
      }
      this.delete(candidate);
    }
  }

  public getMemoryStats() {
    return {
      entries: this.size,
      decodedBytes: this.decodedBytes,
      maxDecodedBytes: this.maxDecodedBytes,
      pinnedEntries: this.pinnedFileIds.size,
    };
  }
}
