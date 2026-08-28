import { ExcalidrawFontFace } from "../fonts/ExcalidrawFontFace";

describe("ExcalidrawFontFace", () => {
  it("uses only explicitly configured self-hosted asset paths", () => {
    const fontFace = new ExcalidrawFontFace(
      "Test Font",
      "fonts/Test Font-Regular.woff2",
    );

    expect(fontFace.urls).toHaveLength(1);
    expect(String(fontFace.urls[0])).toContain(
      "fonts/Test%20Font-Regular.woff2",
    );
    expect(String(fontFace.urls[0])).not.toContain("esm.sh");
  });
});
