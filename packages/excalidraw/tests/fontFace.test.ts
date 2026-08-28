import { ExcalidrawFontFace } from "../fonts/ExcalidrawFontFace";

describe("ExcalidrawFontFace", () => {
  const originalAssetPath = window.EXCALIDRAW_ASSET_PATH;

  afterEach(() => {
    window.EXCALIDRAW_ASSET_PATH = originalAssetPath;
  });

  it("uses only explicitly configured self-hosted asset paths", () => {
    window.EXCALIDRAW_ASSET_PATH = "/";

    const fontFace = new ExcalidrawFontFace(
      "Test Font",
      "fonts/Test Font-Regular.woff2",
    );

    expect(fontFace.urls.map(String)).toEqual([
      `${window.location.origin}/fonts/Test%20Font-Regular.woff2`,
    ]);
  });

  it("uses the public CDN fallback when no asset path is configured", () => {
    window.EXCALIDRAW_ASSET_PATH = undefined;

    const fontFace = new ExcalidrawFontFace(
      "Test Font",
      "fonts/Test-Regular.woff2",
    );

    expect(fontFace.urls.map(String)).toEqual([
      "https://esm.sh/@excalidraw/excalidraw/dist/prod/fonts/Test-Regular.woff2",
    ]);
  });
});
