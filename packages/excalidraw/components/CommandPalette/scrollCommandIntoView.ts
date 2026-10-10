/** Scroll by whole rows so crossing the viewport edge preserves row positions. */
export const scrollCommandIntoView = (
  list: HTMLElement,
  command: HTMLElement,
) => {
  const listBounds = list.getBoundingClientRect();
  const commandBounds = command.getBoundingClientRect();
  const style = getComputedStyle(list);
  const bottomInset =
    Number.parseFloat(style.getPropertyValue("--command-list-bottom-inset")) || 0;
  const rowGap = Number.parseFloat(style.rowGap) || 0;
  const rowStep = commandBounds.height + rowGap;
  if (rowStep <= 0) {
    return;
  }

  const visibleTop = listBounds.top + list.clientTop;
  const visibleBottom = visibleTop + list.clientHeight - bottomInset;
  // Allow subpixel rounding at browser zoom levels without scrolling a full row.
  const tolerance = 0.5;
  if (commandBounds.top < visibleTop - tolerance) {
    list.scrollTop -=
      Math.ceil((visibleTop - commandBounds.top - tolerance) / rowStep) * rowStep;
  } else if (commandBounds.bottom > visibleBottom + tolerance) {
    list.scrollTop +=
      Math.ceil((commandBounds.bottom - visibleBottom - tolerance) / rowStep) *
      rowStep;
  }
};
