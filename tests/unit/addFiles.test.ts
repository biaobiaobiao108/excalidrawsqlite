import { expect, it, spyOn } from "bun:test";
import { ShapeCache } from "@excalidraw/element";
import { MIME_TYPES } from "@excalidraw/common";
import { ImageCache } from "../../packages/excalidraw/imageCache";
import type { BinaryFileData, BinaryFiles, DataURL } from "../../packages/excalidraw/types";
import type { FileId } from "../../packages/element/src/types";

const fileId = (id: string) => id as FileId;
const dataURL = (value: string) => value as DataURL;

const originalGlobals = {
  document: Object.getOwnPropertyDescriptor(globalThis, "document"),
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  devicePixelRatio: Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio"),
};
const fakeWindow = { devicePixelRatio: 1, navigator: { userAgent: "test" } };
Object.defineProperties(globalThis, {
  document: {
    configurable: true,
    value: {
      createElementNS: () => ({
        setAttribute() {},
        appendChild() {},
        removeChild() {},
      }),
      createElement: () => ({ style: {}, getContext: () => ({}), setAttribute() {} }),
      defaultView: fakeWindow,
    },
  },
  window: { configurable: true, value: fakeWindow },
  devicePixelRatio: { configurable: true, value: 1 },
});
const { default: App } = await import("../../packages/excalidraw/components/App");
for (const [key, descriptor] of Object.entries(originalGlobals)) {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}

const restoreGlobal = (key: string, descriptor?: PropertyDescriptor) => {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
};

const createApp = () => {
  const previous = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    devicePixelRatio: Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio"),
  };
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: {
      createElementNS: () => ({ setAttribute() {}, appendChild() {}, removeChild() {} }),
      createElement: () => ({ style: {}, getContext: () => ({}), setAttribute() {} }),
      defaultView: fakeWindow,
    } },
    window: { configurable: true, value: fakeWindow },
    devicePixelRatio: { configurable: true, value: 1 },
  });
  try {
    return new App({} as never);
  } finally {
    restoreGlobal("document", previous.document);
    restoreGlobal("window", previous.window);
    restoreGlobal("devicePixelRatio", previous.devicePixelRatio);
  }
};

it("can replace a file by ID while preserving other files and cached content", () => {
  const app = createApp() as unknown as {
    files: BinaryFiles;
    imageCache: ImageCache;
    scene: { getNonDeletedElements: () => unknown[]; triggerUpdate: () => void };
    addNewImagesToImageCache: () => void;
    addFiles: (files: BinaryFileData[], options?: { replace?: boolean }) => void;
  };
  const imageElement = {
    id: "image-element",
    type: "image",
    fileId: "image-file",
    isDeleted: false,
  };
  app.scene = { getNonDeletedElements: () => [imageElement], triggerUpdate() {} };
  app.addNewImagesToImageCache = () => {};
  app.files = {
    "image-file": {
      id: fileId("image-file"),
      mimeType: MIME_TYPES.png,
      dataURL: dataURL("data:image/png;base64,old"),
      created: 1,
      version: 8,
    },
    "undo-file": {
      id: fileId("undo-file"),
      mimeType: MIME_TYPES.png,
      dataURL: dataURL("data:image/png;base64,undo"),
      created: 1,
      version: 3,
    },
  };
  const originalImageFile = app.files["image-file"];
  const originalUndoFile = app.files["undo-file"];
  const decodedImage = { width: 1, height: 1, naturalWidth: 1, naturalHeight: 1 } as unknown as HTMLImageElement;
  app.imageCache.set("image-file" as never, {
    image: decodedImage as never,
    mimeType: MIME_TYPES.png,
  });
  const deleteShape = spyOn(ShapeCache, "delete");

  try {
    app.addFiles([
      { ...originalImageFile, dataURL: dataURL("data:image/png;base64,ignored"), version: 20 },
    ]);
    expect(app.files["image-file"]).toBe(originalImageFile);
    expect(app.files["undo-file"]).toBe(originalUndoFile);

    app.addFiles(
      [{ ...originalImageFile }],
      { replace: true },
    );
    expect(app.files["image-file"]).toBe(originalImageFile);
    expect(app.files["image-file"].version).toBe(8);
    expect(app.imageCache.get("image-file" as never)?.image).toBe(decodedImage);
    expect(deleteShape).not.toHaveBeenCalled();

    app.addFiles(
      [
        { ...originalImageFile, dataURL: dataURL("data:image/png;base64,new"), version: 2 },
        {
          id: fileId("new-file"),
          mimeType: MIME_TYPES.png,
          dataURL: dataURL("data:image/png;base64,new-file"),
          created: 1,
        },
      ],
      { replace: true },
    );
    expect(app.files["image-file"].version).toBe(9);
    expect(app.files["image-file"].dataURL).toBe(dataURL("data:image/png;base64,new"));
    expect(app.files["new-file"]?.dataURL).toBe(dataURL("data:image/png;base64,new-file"));
    expect(app.files["undo-file"]).toBe(originalUndoFile);
    expect(app.imageCache.has("image-file" as never)).toBe(false);
    expect(deleteShape).toHaveBeenCalledWith(imageElement);

    app.imageCache.set("image-file" as never, {
      image: decodedImage,
      mimeType: MIME_TYPES.png,
    });
    app.addFiles(
      [{ ...app.files["image-file"], mimeType: MIME_TYPES.jpg }],
      { replace: true },
    );
    expect(app.files["image-file"].version).toBe(10);
    expect(app.files["image-file"].mimeType).toBe(MIME_TYPES.jpg);
    expect(app.imageCache.has("image-file" as never)).toBe(false);
    expect(deleteShape).toHaveBeenCalledTimes(2);
  } finally {
    deleteShape.mockRestore();
    app.imageCache.clear();
  }
});
