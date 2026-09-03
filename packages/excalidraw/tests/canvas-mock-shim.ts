// Canvas mock shim for Bun test
export function setupCanvasMock(targetWindow: any = typeof window !== "undefined" ? window : globalThis) {
  const CanvasElement = targetWindow.HTMLCanvasElement || (globalThis as any).HTMLCanvasElement;
  if (!CanvasElement) return;

  const dummyContext = {
    fillRect: () => {},
    clearRect: () => {},
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
    translate: () => {},
    scale: () => {},
    rotate: () => {},
    arc: () => {},
    fill: () => {},
    measureText: (text: string) => ({
      width: text.length * 10,
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
    canvas: {},
  };

  HTMLCanvasElement.prototype.getContext = function (contextType: string) {
    if (contextType === "2d") {
      return dummyContext as any;
    }
    return null;
  };

  HTMLCanvasElement.prototype.toDataURL = function () {
    return "data:image/png;base64,";
  };

  HTMLCanvasElement.prototype.toBlob = function (callback: any) {
    callback(new Blob([], { type: "image/png" }));
  };
}

setupCanvasMock();
