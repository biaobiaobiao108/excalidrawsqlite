import { getDeviceMemoryTier } from "@excalidraw/common";

const DEFAULT_EDITOR_PIXEL_BUDGET = 32_000_000;
const UNKNOWN_MEMORY_EDITOR_PIXEL_BUDGET = 24_000_000;
const LOW_MEMORY_EDITOR_PIXEL_BUDGET = 16_000_000;

type RenderScaleOptions = {
  width: number;
  height: number;
  devicePixelRatio: number;
  canvasCount: number;
  deviceMemory?: number;
  userAgent?: string;
};

export const getEditorRenderScale = ({
  width,
  height,
  devicePixelRatio,
  canvasCount,
  deviceMemory,
  userAgent = "",
}: RenderScaleOptions) => {
  const safeWidth =
    Number.isFinite(width) && width > 0 ? Math.max(1, width) : 1;
  const safeHeight =
    Number.isFinite(height) && height > 0 ? Math.max(1, height) : 1;
  const activeCanvasCount = Number.isFinite(canvasCount)
    ? Math.max(1, Math.floor(canvasCount))
    : 1;
  const memoryTier = getDeviceMemoryTier(deviceMemory, userAgent);
  const pixelBudget =
    memoryTier === "low"
      ? LOW_MEMORY_EDITOR_PIXEL_BUDGET
      : memoryTier === "unknown"
        ? UNKNOWN_MEMORY_EDITOR_PIXEL_BUDGET
        : DEFAULT_EDITOR_PIXEL_BUDGET;
  const budgetedScale =
    (Math.sqrt(pixelBudget) /
      (Math.sqrt(safeWidth) *
        Math.sqrt(safeHeight) *
        Math.sqrt(activeCanvasCount))) *
    (1 - 1e-6);
  const requestedScale = Number.isFinite(devicePixelRatio)
    ? Math.max(Number.EPSILON, devicePixelRatio)
    : 1;

  // Never apply a readability floor here: on very large viewports it would
  // multiply the backing store past the aggregate canvas pixel budget.
  return Math.min(requestedScale, budgetedScale);
};

const CANVAS_ALLOCATION_RETRIES = 8;
const CANVAS_ALLOCATION_RETRY_FACTOR = 0.75;

/**
 * Set a canvas backing store, retrying at progressively lower scales when a
 * browser rejects an allocation. The caller can lower the editor-wide scale
 * so the other canvas layers stay aligned on the next render.
 */
export const setCanvasDimensionsWithFallback = (
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  requestedScale: number,
  onScaleFallback?: (scale: number) => void,
) => {
  const scale = Number.isFinite(requestedScale) && requestedScale > 0
    ? requestedScale
    : Number.EPSILON;
  let attemptScale = scale;
  let lastAttemptScale = scale;

  for (let attempt = 0; attempt <= CANVAS_ALLOCATION_RETRIES; attempt++) {
    lastAttemptScale = attemptScale;
    const expectedWidth = Math.max(1, Math.floor(width * attemptScale));
    const expectedHeight = Math.max(1, Math.floor(height * attemptScale));
    try {
      canvas.width = expectedWidth;
      canvas.height = expectedHeight;
      if (
        canvas.width === expectedWidth &&
        canvas.height === expectedHeight
      ) {
        if (attemptScale < scale) {
          onScaleFallback?.(attemptScale);
        }
        return attemptScale;
      }
    } catch {
      // Some browsers throw for an over-budget backing store; retry smaller.
    }
    attemptScale *= CANVAS_ALLOCATION_RETRY_FACTOR;
  }

  if (lastAttemptScale < scale) {
    onScaleFallback?.(lastAttemptScale);
  }
  return lastAttemptScale;
};

export const getEditorCanvasPixelBudget = (
  deviceMemory?: number,
  userAgent = "",
) => {
  const memoryTier = getDeviceMemoryTier(deviceMemory, userAgent);
  return memoryTier === "low"
    ? LOW_MEMORY_EDITOR_PIXEL_BUDGET
    : memoryTier === "unknown"
      ? UNKNOWN_MEMORY_EDITOR_PIXEL_BUDGET
      : DEFAULT_EDITOR_PIXEL_BUDGET;
};
