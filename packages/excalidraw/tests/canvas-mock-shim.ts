// Canvas mock shim for Bun test
export function setupCanvasMock(targetWindow: any = typeof window !== "undefined" ? window : globalThis) {
  const CanvasElement = targetWindow.HTMLCanvasElement || (globalThis as any).HTMLCanvasElement;
  if (!CanvasElement) return;

  const dummyContext = {
    getImageData: (x = 0, y = 0, w = 1, h = 1) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    }),
    putImageData: () => {},
    createImageData: () => [],
    setTransform: () => {},
    drawImage: () => {},
    save: () => {},
    fillText: () => {},
    restore: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    stroke: () => {},
    strokeRect: () => {},
    strokeText: () => {},
    setLineDash: () => {},
    getLineDash: () => [],
    translate: () => {},
    scale: () => {},
    rotate: () => {},
    arc: () => {},
    fill: () => {},
    measureText: (text: string) => ({
      width: text.length,
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 2,
    }),
    transform: () => {},
    rect: () => {},
    clip: () => {},
    bezierCurveTo: () => {},
    quadraticCurveTo: () => {},
    arcTo: () => {},
    ellipse: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createPattern: () => ({}),
    resetTransform: () => {},
    isPointInPath: () => false,
    isPointInStroke: () => false,
    canvas: null,
  };

  CanvasElement.prototype.getContext = function (contextType: string) {
    if (contextType === "2d") {
      const events: Array<{ type: string; props: Record<string, unknown> }> =
        [];
      const record = (type: string, props: Record<string, unknown>) => {
        events.push({ type, props });
      };

      return {
        ...dummyContext,
        canvas: this,
        fillRect: (x: number, y: number, width: number, height: number) =>
          record("fillRect", { x, y, width, height }),
        clearRect: (x: number, y: number, width: number, height: number) =>
          record("clearRect", { x, y, width, height }),
        clip: (...args: unknown[]) =>
          record("clip", {
            fillRule: typeof args.at(-1) === "string" ? args.at(-1) : undefined,
          }),
        __getEvents: () => events,
        __clearEvents: () => {
          events.length = 0;
        },
      } as any;
    }
    return null;
  };

  CanvasElement.prototype.toDataURL = function () {
    return "data:image/png;base64,";
  };

  CanvasElement.prototype.toBlob = function (callback: any) {
    callback(new Blob([], { type: "image/png" }));
  };
}

setupCanvasMock();
