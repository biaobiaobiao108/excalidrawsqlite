// -----------------------------------------------------------------------------
// ExcalidrawImageElement & related helpers
// -----------------------------------------------------------------------------

import { getDeviceMemoryTier, MIME_TYPES, SVG_NS } from "@excalidraw/common";

import type {
  AppClassProperties,
  DataURL,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";

import { isInitializedImageElement } from "./typeChecks";

import type {
  ExcalidrawElement,
  FileId,
  InitializedExcalidrawImageElement,
} from "./types";

export const loadHTMLImageElement = (dataURL: DataURL) => {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      resolve(image);
    };
    image.onerror = (error) => {
      reject(error);
    };
    image.src = dataURL;
  });
};

const FALLBACK_IMAGE_DECODE_BUDGET_BYTES = 128 * 1024 * 1024;
const MIN_IMAGE_DECODE_RESERVATION_BYTES = 4 * 1024 * 1024;

type DecodeLimiter = {
  budgetBytes: number;
  concurrency: number;
  activeBytes: number;
  activeCount: number;
  waiting: Array<{
    bytes: number;
    resolve: (release: () => void) => void;
  }>;
};

const imageDecodeLimiters = new WeakMap<object, DecodeLimiter>();

const getImageDecodeLimiter = (
  imageCache: AppClassProperties["imageCache"],
) => {
  const key = imageCache as object;
  let limiter = imageDecodeLimiters.get(key);
  if (!limiter) {
    const stats = (
      imageCache as AppClassProperties["imageCache"] & {
        getMemoryStats?: () => { maxDecodedBytes?: number };
      }
    ).getMemoryStats?.();
    const deviceMemory =
      typeof navigator === "undefined"
        ? undefined
        : (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    const userAgent =
      typeof navigator === "undefined" ? "" : navigator.userAgent;
    const tier = getDeviceMemoryTier(deviceMemory, userAgent);
    limiter = {
      budgetBytes: stats?.maxDecodedBytes || FALLBACK_IMAGE_DECODE_BUDGET_BYTES,
      concurrency: tier === "standard" ? 4 : 2,
      activeBytes: 0,
      activeCount: 0,
      waiting: [],
    };
    imageDecodeLimiters.set(key, limiter);
  }
  return limiter;
};

const acquireImageDecodeBudget = (
  limiter: DecodeLimiter,
  bytes: number,
) =>
  new Promise<() => void>((resolve) => {
    limiter.waiting.push({ bytes, resolve });
    const drain = () => {
      while (limiter.activeCount < limiter.concurrency) {
        const index = limiter.waiting.findIndex(
          (request) =>
            limiter.activeCount === 0 ||
            limiter.activeBytes + request.bytes <= limiter.budgetBytes,
        );
        if (index < 0) {
          return;
        }
        const [request] = limiter.waiting.splice(index, 1);
        if (!request) {
          return;
        }
        limiter.activeCount += 1;
        limiter.activeBytes += request.bytes;
        let released = false;
        request.resolve(() => {
          if (released) {
            return;
          }
          released = true;
          limiter.activeCount -= 1;
          limiter.activeBytes -= request.bytes;
          drain();
        });
      }
    };
    drain();
  });

const estimateImageDecodeBytes = (
  dataURL: DataURL,
  budgetBytes: number,
) =>
  Math.min(
    budgetBytes,
    Math.max(MIN_IMAGE_DECODE_RESERVATION_BYTES, dataURL.length * 8),
  );

/** NOTE: updates cache even if already populated with given image. Thus,
 * you should filter out the images upstream if you want to optimize this. */
export const updateImageCache = async ({
  fileIds,
  files,
  imageCache,
}: {
  fileIds: FileId[];
  files: BinaryFiles;
  imageCache: AppClassProperties["imageCache"];
}) => {
  const updatedFiles = new Map<FileId, true>();
  const erroredFiles = new Map<FileId, true>();
  const limiter = getImageDecodeLimiter(imageCache);
  const budgetBytes = limiter.budgetBytes;
  const uniqueFileIds = [...new Set(fileIds)];
  let nextIndex = 0;
  const loadNext = async () => {
    while (nextIndex < uniqueFileIds.length) {
      const fileId = uniqueFileIds[nextIndex++];
      const fileData = files[fileId as string];
      if (!fileData) {
        continue;
      }

      updatedFiles.set(fileId, true);
      let release: (() => void) | null = null;
      let pendingImagePromise: Promise<HTMLImageElement> | null = null;
      try {
        if (fileData.mimeType === MIME_TYPES.binary) {
          throw new Error("Only images can be added to ImageCache");
        }

        const estimatedDecodedBytes = estimateImageDecodeBytes(
          fileData.dataURL,
          budgetBytes,
        );
        release = await acquireImageDecodeBudget(
          limiter,
          estimatedDecodedBytes,
        );
        const imagePromise = loadHTMLImageElement(fileData.dataURL);
        pendingImagePromise = imagePromise;
        const data = {
          image: imagePromise,
          mimeType: fileData.mimeType,
          estimatedDecodedBytes,
        } as const;
        // Reserve memory while decoding so pending image promises participate
        // in the cache budget and are visible in development memory stats.
        imageCache.set(fileId, data);
        const image = await imagePromise;
        imageCache.set(fileId, { image, mimeType: fileData.mimeType });
      } catch {
        erroredFiles.set(fileId, true);
        if (imageCache.get(fileId)?.image === pendingImagePromise) {
          imageCache.delete(fileId);
        }
      } finally {
        release?.();
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limiter.concurrency, uniqueFileIds.length) }, () =>
      loadNext(),
    ),
  );

  return {
    imageCache,
    /** includes errored files because they cache was updated nonetheless */
    updatedFiles,
    /** files that failed when creating HTMLImageElement */
    erroredFiles,
  };
};

export const getInitializedImageElements = (
  elements: readonly ExcalidrawElement[],
) =>
  elements.filter((element) =>
    isInitializedImageElement(element),
  ) as InitializedExcalidrawImageElement[];

export const isHTMLSVGElement = (node: Node | null): node is SVGElement => {
  // lower-casing due to XML/HTML convention differences
  // https://johnresig.com/blog/nodename-case-sensitivity
  return node?.nodeName.toLowerCase() === "svg";
};

export const normalizeSVG = (SVGString: string) => {
  const doc = new DOMParser().parseFromString(SVGString, MIME_TYPES.svg);
  const svg = doc.querySelector("svg");
  const errorNode = doc.querySelector("parsererror");
  if (errorNode || !isHTMLSVGElement(svg)) {
    throw new Error("Invalid SVG");
  } else {
    if (!svg.hasAttribute("xmlns")) {
      svg.setAttribute("xmlns", SVG_NS);
    }

    let width = svg.getAttribute("width");
    let height = svg.getAttribute("height");

    // Do not use % or auto values for width/height
    // to avoid scaling issues when rendering at different sizes/zoom levels
    if (width?.includes("%") || width === "auto") {
      width = null;
    }
    if (height?.includes("%") || height === "auto") {
      height = null;
    }

    const viewBox = svg.getAttribute("viewBox");

    if (!width || !height) {
      width = width || "50";
      height = height || "50";

      if (viewBox) {
        const match = viewBox.match(
          /\d+ +\d+ +(\d+(?:\.\d+)?) +(\d+(?:\.\d+)?)/,
        );
        if (match) {
          [, width, height] = match;
        }
      }

      svg.setAttribute("width", width);
      svg.setAttribute("height", height);
    }

    // Make sure viewBox is set
    if (!viewBox) {
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    }

    return svg.outerHTML;
  }
};
