import { beforeEach, describe, it, expect, vi } from "vitest";

import { EDITOR_LS_KEYS } from "@excalidraw/common";

import { Excalidraw } from "../index";
import { EditorLocalStorage } from "../data/EditorLocalStorage";

import { getTextEditor, updateTextEditor } from "./queries/dom";
import { render, waitFor, screen } from "./test-utils";

vi.mock("@codemirror/view", () => ({}));
vi.mock("@codemirror/state", () => ({}));
vi.mock("@codemirror/language", () => ({}));
vi.mock("@lezer/highlight", () => ({}));

describe("Test <OutlineToDiagram/>", () => {
  beforeEach(async () => {
    EditorLocalStorage.delete(EDITOR_LS_KEYS.OUTLINE_TO_DIAGRAM);

    await render(
      <Excalidraw
        initialData={{
          appState: {
            openDialog: { name: "ttd", tab: "outline" },
          },
        }}
      />,
    );
  });

  it("renders the outline tab with input editor and canvas preview", async () => {
    const dialog = document.querySelector(".ttd-dialog")!;
    expect(dialog).not.toBeNull();

    await waitFor(
      () => {
        expect(dialog.querySelector("canvas")).not.toBeNull();
        expect(
          dialog.querySelector('[data-testid="ttd-dialog-output-error"]'),
        ).toBeNull();
      },
      { timeout: 4000 },
    );

    const insertButtons = screen.getAllByRole("button", {
      name: /Insert|插入/i,
    });
    expect(insertButtons.length).toBeGreaterThan(0);
  });

  it("allows updating outline text and rendering preview", async () => {
    const selector = ".ttd-dialog-input";
    let editor = await getTextEditor({ selector, waitForEditor: true });

    expect(editor.textContent).toContain("本期视频大纲");

    updateTextEditor(editor, "# New Topic\n- Item 1\n- Item 2");
    editor = await getTextEditor({ selector, waitForEditor: false });

    expect(editor.textContent).toBe("# New Topic\n- Item 1\n- Item 2");

    const dialog = document.querySelector(".ttd-dialog")!;
    await waitFor(() => {
      expect(dialog.querySelector("canvas")).not.toBeNull();
    });
  });
});
