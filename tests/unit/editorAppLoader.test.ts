import { describe, expect, it } from "bun:test";
import { createEditorAppLoader } from "../../excalidraw-app/editorAppLoader";

describe("editor app loader", () => {
  it("retries after a failed import and shares an in-flight/successful load", async () => {
    let attempts = 0;
    const editorModule = {
      default: (() => null) as never,
    } as unknown as typeof import("../../excalidraw-app/EditorApp");
    const loadEditorApp = createEditorAppLoader(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("chunk unavailable");
      }
      return editorModule;
    });

    await expect(loadEditorApp()).rejects.toThrow("chunk unavailable");
    const [first, second] = await Promise.all([
      loadEditorApp(),
      loadEditorApp(),
    ]);

    expect(first).toBe(editorModule);
    expect(second).toBe(editorModule);
    expect(attempts).toBe(2);
  });
});
