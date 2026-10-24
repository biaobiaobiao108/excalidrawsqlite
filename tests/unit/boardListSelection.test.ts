import { describe, expect, test } from "bun:test";

import {
  applyBoardSelectionClick,
  pruneBoardSelection,
  type BoardSelectionState,
} from "../../excalidraw-app/components/board-list-selection";

const orderedIds = ["a", "b", "c", "d", "e"];

const selection = (
  ids: string[] = [],
  anchorId: string | null = null,
): BoardSelectionState => ({ ids: new Set(ids), anchorId });

describe("board list selection", () => {
  test("plain selection starts a new selection and modifier clicks toggle individual boards", () => {
    const first = applyBoardSelectionClick(
      selection(["a", "c"], "c"),
      orderedIds,
      {
        id: "d",
      },
    );
    expect([...first.ids]).toEqual(["d"]);

    const added = applyBoardSelectionClick(first, orderedIds, {
      id: "b",
      ctrlKey: true,
    });
    expect([...added.ids]).toEqual(["d", "b"]);

    const removed = applyBoardSelectionClick(added, orderedIds, {
      id: "d",
      metaKey: true,
    });
    expect([...removed.ids]).toEqual(["b"]);
  });

  test("shift selects the inclusive range from the existing anchor", () => {
    const next = applyBoardSelectionClick(selection(["b"], "b"), orderedIds, {
      id: "e",
      shiftKey: true,
    });
    expect([...next.ids]).toEqual(["b", "c", "d", "e"]);
    expect(next.anchorId).toBe("b");
  });

  test("pruning removes boards outside the current list and repairs the anchor", () => {
    const next = pruneBoardSelection(selection(["a", "c", "e"], "e"), [
      "b",
      "c",
      "d",
    ]);
    expect([...next.ids]).toEqual(["c"]);
    expect(next.anchorId).toBe("c");
  });
});
