const DEFAULT_EDITOR_PIXEL_BUDGET = 32_000_000;
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
  const cssPixelCount = Math.max(1, width * height);
  const activeCanvasCount = Math.max(1, canvasCount);
  const isLowMemory =
    (typeof deviceMemory === "number" && deviceMemory <= 4) ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
  const pixelBudget = isLowMemory
    ? LOW_MEMORY_EDITOR_PIXEL_BUDGET
    : DEFAULT_EDITOR_PIXEL_BUDGET;
  const budgetedScale = Math.sqrt(
    pixelBudget / (cssPixelCount * activeCanvasCount),
  );
  const requestedScale = Number.isFinite(devicePixelRatio)
    ? Math.max(0.5, devicePixelRatio)
    : 1;

  return Math.min(requestedScale, Math.max(0.5, budgetedScale));
};

export const getEditorCanvasPixelBudget = (deviceMemory?: number) =>
  typeof deviceMemory === "number" && deviceMemory <= 4
    ? LOW_MEMORY_EDITOR_PIXEL_BUDGET
    : DEFAULT_EDITOR_PIXEL_BUDGET;
