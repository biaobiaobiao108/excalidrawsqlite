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
const MAX_IMAGE_HEADER_BYTES = 64 * 1024;

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

const acquireImageDecodeBudget = (limiter: DecodeLimiter, bytes: number) =>
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

const getImageHeaderBytes = (dataURL: DataURL) => {
  const separator = dataURL.indexOf(",");
  if (separator < 0) {
    return null;
  }
  const metadata = dataURL.slice(0, separator).toLowerCase();
  if (!metadata.includes(";base64")) {
    return null;
  }

  const payload = dataURL.slice(separator + 1);
  const maxEncodedLength = Math.ceil(MAX_IMAGE_HEADER_BYTES / 3) * 4;
  const encodedPrefix = payload.slice(0, maxEncodedLength);
  const alignedPrefix = encodedPrefix.slice(
    0,
    encodedPrefix.length - (encodedPrefix.length % 4),
  );
  try {
    const binary = atob(alignedPrefix);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
};

const parseSvgLength = (value: string | undefined) => {
  if (!value) {
    return null;
  }
  const match = value.trim().match(/^([\d.]+)(px|pt|pc|mm|cm|in)?$/i);
  if (!match) {
    return null;
  }
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
  const scale = (
    {
      px: 1,
      pt: 96 / 72,
      pc: 16,
      mm: 96 / 25.4,
      cm: 96 / 2.54,
      in: 96,
    } as Record<string, number>
  )[match[2]?.toLowerCase() || "px"];
  return number * scale;
};

const getSvgDimensions = (dataURL: DataURL) => {
  const separator = dataURL.indexOf(",");
  if (separator < 0) {
    return null;
  }
  const metadata = dataURL.slice(0, separator).toLowerCase();
  const payload = dataURL.slice(
    separator + 1,
    separator + 1 + MAX_IMAGE_HEADER_BYTES,
  );
  let source: string;
  try {
    source = metadata.includes(";base64")
      ? atob(payload.slice(0, payload.length - (payload.length % 4)))
      : decodeURIComponent(payload);
  } catch {
    return null;
  }

  const svgTag = source.match(/<svg\b([^>]*)>/i)?.[1];
  if (!svgTag) {
    return null;
  }
  const getAttribute = (name: string) =>
    svgTag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];
  let width = parseSvgLength(getAttribute("width"));
  let height = parseSvgLength(getAttribute("height"));
  const viewBox = getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    viewBox?.length === 4 &&
    viewBox.every((value) => Number.isFinite(value)) &&
    viewBox[2] > 0 &&
    viewBox[3] > 0
  ) {
    if (width && !height) {
      height = (width * viewBox[3]) / viewBox[2];
    } else if (height && !width) {
      width = (height * viewBox[2]) / viewBox[3];
    } else if (!width && !height) {
      width = viewBox[2];
      height = viewBox[3];
    }
  }
  return width && height ? { width, height } : null;
};

const getImageDimensions = (dataURL: DataURL) => {
  const separator = dataURL.indexOf(",");
  if (separator < 0) {
    return null;
  }
  const headerBytes = getImageHeaderBytes(dataURL);
  if (!headerBytes) {
    return dataURL.slice(0, separator).toLowerCase().includes("svg")
      ? getSvgDimensions(dataURL)
      : null;
  }
  const view = new DataView(
    headerBytes.buffer,
    headerBytes.byteOffset,
    headerBytes.byteLength,
  );
  const mimeType = dataURL.slice(0, separator).toLowerCase();

  if (
    mimeType.includes("image/png") &&
    headerBytes.length >= 24 &&
    String.fromCharCode(...headerBytes.subarray(12, 16)) === "IHDR"
  ) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  if (mimeType.includes("image/gif") && headerBytes.length >= 10) {
    return {
      width: view.getUint16(6, true),
      height: view.getUint16(8, true),
    };
  }

  if (mimeType.includes("image/bmp") && headerBytes.length >= 26) {
    const dibHeaderSize = view.getUint32(14, true);
    if (dibHeaderSize === 12) {
      return {
        width: view.getUint16(18, true),
        height: view.getUint16(20, true),
      };
    }
    if (dibHeaderSize < 40) {
      return null;
    }
    return {
      width: Math.abs(view.getInt32(18, true)),
      height: Math.abs(view.getInt32(22, true)),
    };
  }

  if (mimeType.includes("image/x-icon") && headerBytes.length >= 8) {
    return {
      width: headerBytes[6] || 256,
      height: headerBytes[7] || 256,
    };
  }

  if (
    mimeType.includes("image/webp") &&
    headerBytes.length >= 25 &&
    String.fromCharCode(...headerBytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...headerBytes.subarray(8, 12)) === "WEBP"
  ) {
    const chunk = String.fromCharCode(...headerBytes.subarray(12, 16));
    if (chunk === "VP8X" && headerBytes.length >= 30) {
      return {
        width:
          1 +
          headerBytes[24] +
          (headerBytes[25] << 8) +
          (headerBytes[26] << 16),
        height:
          1 +
          headerBytes[27] +
          (headerBytes[28] << 8) +
          (headerBytes[29] << 16),
      };
    }
    if (
      chunk === "VP8 " &&
      headerBytes.length >= 30 &&
      headerBytes[23] === 0x9d &&
      headerBytes[24] === 0x01 &&
      headerBytes[25] === 0x2a
    ) {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
    if (
      chunk === "VP8L" &&
      headerBytes.length >= 25 &&
      headerBytes[20] === 0x2f
    ) {
      const width = 1 + headerBytes[21] + ((headerBytes[22] & 0x3f) << 8);
      const height =
        1 +
        (headerBytes[22] >> 6) +
        (headerBytes[23] << 2) +
        ((headerBytes[24] & 0x0f) << 10);
      return { width, height };
    }
  }

  if (mimeType.includes("image/jpeg") || mimeType.includes("image/jfif")) {
    let offset = 2;
    while (offset + 4 < headerBytes.length) {
      if (headerBytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      while (headerBytes[offset] === 0xff) {
        offset++;
      }
      const marker = headerBytes[offset++];
      if (marker === 0xd9 || marker === 0xda) {
        break;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;
      }
      if (offset + 1 >= headerBytes.length) {
        break;
      }
      const segmentLength = view.getUint16(offset);
      if (offset + segmentLength > headerBytes.length) {
        break;
      }
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        return {
          height: view.getUint16(offset + 3),
          width: view.getUint16(offset + 5),
        };
      }
      offset += segmentLength;
    }
  }

  if (mimeType.includes("image/avif") && headerBytes.length >= 20) {
    for (let offset = 4; offset + 16 <= headerBytes.length; offset++) {
      if (
        String.fromCharCode(...headerBytes.subarray(offset, offset + 4)) ===
        "ispe"
      ) {
        return {
          width: view.getUint32(offset + 8),
          height: view.getUint32(offset + 12),
        };
      }
    }
  }

  return null;
};

const estimateImageDecodeBytes = (dataURL: DataURL, budgetBytes: number) => {
  const dimensions = getImageDimensions(dataURL);
  if (!dimensions) {
    // Unknown formats may be highly compressed. Serialize their decodes
    // against the entire cache budget instead of trusting encoded byte length.
    return budgetBytes;
  }
  const decodedBytes = dimensions.width * dimensions.height * 4;
  if (!Number.isFinite(decodedBytes) || decodedBytes <= 0) {
    return budgetBytes;
  }
  // Keep the real estimate when one image exceeds the shared budget. The
  // limiter permits that single decode only while no other decode is active;
  // capping the reservation here would allow multiple oversized images to
  // decode concurrently and exceed the intended peak-memory bound.
  return Math.max(MIN_IMAGE_DECODE_RESERVATION_BYTES, decodedBytes);
};

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
    Array.from(
      { length: Math.min(limiter.concurrency, uniqueFileIds.length) },
      () => loadNext(),
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
