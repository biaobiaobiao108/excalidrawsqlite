import { beforeEach, describe, it, expect, vi } from "vitest";

import { EDITOR_LS_KEYS } from "@excalidraw/common";

import { Excalidraw } from "../index";
import { EditorLocalStorage } from "../data/EditorLocalStorage";

import { TTDDialog } from "../components/TTDDialog/TTDDialog";

import { render, waitFor, screen, fireEvent } from "./test-utils";

vi.mock("@codemirror/view", () => ({}));
vi.mock("@codemirror/state", () => ({}));
vi.mock("@codemirror/language", () => ({}));
vi.mock("@lezer/highlight", () => ({}));

describe("Test <OutlineToDiagram/>", () => {
  beforeEach(async () => {
    EditorLocalStorage.delete(EDITOR_LS_KEYS.OUTLINE_TO_DIAGRAM);
    EditorLocalStorage.delete(EDITOR_LS_KEYS.OUTLINE_LAYOUT);

    await render(
      <Excalidraw
        initialData={{
          appState: {
            openDialog: { name: "ttd", tab: "outline" },
          },
        }}
      >
        <TTDDialog
          onTextSubmit={vi.fn()}
          persistenceAdapter={
            {
              load: vi.fn(),
              save: vi.fn(),
            } as any
          }
        />
      </Excalidraw>,
    );
  });

  it("renders the outline tab with layout switcher and editor", async () => {
    await waitFor(
      () => {
        expect(
          screen.getByRole("button", { name: /Mindmap|横向/i }),
        ).toBeInTheDocument();
      },
      { timeout: 4000 },
    );

    expect(
      screen.getByRole("button", { name: /Hierarchy|架构树/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Storyboard|分镜/i }),
    ).toBeInTheDocument();

    const textarea = document.querySelector(".outline-editor-wrapper textarea");
    expect(textarea).toBeInTheDocument();
  });

  it("allows switching layout modes and editing outline", async () => {
    await waitFor(
      () => {
        expect(
          screen.getByRole("button", { name: /Hierarchy|架构树/i }),
        ).toBeInTheDocument();
      },
      { timeout: 4000 },
    );

    const hierarchyBtn = screen.getByRole("button", {
      name: /Hierarchy|架构树/i,
    });
    fireEvent.click(hierarchyBtn);
    expect(hierarchyBtn.classList.contains("active")).toBe(true);

    const textarea = document.querySelector(
      ".outline-editor-wrapper textarea",
    ) as HTMLTextAreaElement;
    expect(textarea).toBeInTheDocument();

    fireEvent.change(textarea, {
      target: { value: "# New Root\n- Point 1\n- Point 2" },
    });
    expect(textarea.value).toBe("# New Root\n- Point 1\n- Point 2");
  });
});
