export type BoardSelectionState = {
  ids: Set<string>;
  anchorId: string | null;
};

export type BoardSelectionClick = {
  id: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
};

export const isBoardSelectionModifierClick = (
  click: Pick<BoardSelectionClick, "metaKey" | "ctrlKey" | "shiftKey">,
) => Boolean(click.metaKey || click.ctrlKey || click.shiftKey);

export const applyBoardSelectionClick = (
  state: BoardSelectionState,
  orderedIds: readonly string[],
  click: BoardSelectionClick,
): BoardSelectionState => {
  if (!orderedIds.includes(click.id)) {
    return state;
  }

  if (click.shiftKey) {
    const anchorIndex = state.anchorId
      ? orderedIds.indexOf(state.anchorId)
      : -1;
    if (anchorIndex < 0) {
      return { ids: new Set([click.id]), anchorId: click.id };
    }
    const clickedIndex = orderedIds.indexOf(click.id);
    return {
      ids: new Set(
        orderedIds.slice(
          Math.min(anchorIndex, clickedIndex),
          Math.max(anchorIndex, clickedIndex) + 1,
        ),
      ),
      anchorId: state.anchorId,
    };
  }

  if (click.metaKey || click.ctrlKey) {
    const ids = new Set(state.ids);
    if (ids.has(click.id)) {
      ids.delete(click.id);
    } else {
      ids.add(click.id);
    }
    return { ids, anchorId: click.id };
  }

  return { ids: new Set([click.id]), anchorId: click.id };
};

export const pruneBoardSelection = (
  state: BoardSelectionState,
  orderedIds: readonly string[],
): BoardSelectionState => {
  const visibleIds = new Set(orderedIds);
  const ids = new Set([...state.ids].filter((id) => visibleIds.has(id)));
  const firstSelectedId = ids.values().next().value;
  const anchorId =
    state.anchorId && visibleIds.has(state.anchorId)
      ? state.anchorId
      : typeof firstSelectedId === "string"
        ? firstSelectedId
        : null;
  return { ids, anchorId };
};
