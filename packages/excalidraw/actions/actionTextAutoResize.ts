import { getFontString, KEYS, matchKey } from "@excalidraw/common";

import {
  getTextAnchorRatios,
  isBoundToContainer,
  isExcalidrawElement,
  isNonDeletedElement,
  newElementWith,
  updateBoundElements,
  wrapText,
} from "@excalidraw/element";
import { measureText } from "@excalidraw/element";

import { isTextElement } from "@excalidraw/element";

import { CaptureUpdateAction } from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
} from "@excalidraw/element/types";

import { getSelectedElements } from "../scene";

import { register } from "./register";

import type { AppClassProperties, AppState } from "../types";

/** the selected free texts (a container's text follows its container) */
const getSelectedFreeTexts = (
  elements: readonly ExcalidrawElement[],
  appState: Readonly<AppState>,
) =>
  getSelectedElements(elements, appState).filter(
    (element) => isTextElement(element) && !isBoundToContainer(element),
  );

const KEPT_TEXT_WIDTH_SLACK = 1;

const toggleTextAutoResize = (
  text: ExcalidrawTextElement,
  autoResize: boolean,
) => {
  const font = getFontString(text);
  const width = autoResize ? null : text.width + KEPT_TEXT_WIDTH_SLACK;
  const nextText =
    width === null
      ? text.originalText
      : wrapText(text.originalText, font, width);
  const metrics = measureText(nextText, font, text.lineHeight);
  const nextWidth = width ?? metrics.width;

  const anchor = getTextAnchorRatios(text);

  return newElementWith(text, {
    autoResize,
    width: nextWidth,
    height: metrics.height,
    x: text.x + (text.width - nextWidth) * anchor.x,
    y: text.y + (text.height - metrics.height) * anchor.y,
    text: nextText,
  });
};

export const isTextAutoResizeShortcut = (
  event: KeyboardEvent | React.KeyboardEvent<Element>,
) =>
  event.altKey &&
  !event[KEYS.CTRL_OR_CMD] &&
  !event.shiftKey &&
  matchKey(event, KEYS.W);

export const actionTextAutoResize = register({
  name: "autoResize",
  label: "labels.autoResize",
  icon: null,
  trackEvent: { category: "element" },
  predicate: (elements, appState, _: unknown) => {
    const selectedElements = getSelectedElements(elements, appState);
    return (
      selectedElements.length === 1 &&
      isTextElement(selectedElements[0]) &&
      !selectedElements[0].autoResize
    );
  },
  /**
   * Toggles auto-resizing of the given text (e.g. the one being edited), or
   * else of the selected free texts: on if any of them wraps, else off.
   */
  perform: (elements, appState, targetElement, app) => {
    const targetIds = new Set(
      (isExcalidrawElement(targetElement) &&
      isTextElement(targetElement) &&
      !isBoundToContainer(targetElement)
        ? [targetElement]
        : getSelectedFreeTexts(elements, appState)
      ).map((element) => element.id),
    );
    const targets = elements.filter(
      (element) => targetIds.has(element.id) && isTextElement(element),
    ) as ExcalidrawTextElement[];

    if (!targets.length) {
      return false;
    }

    const autoResize = targets.some((text) => !text.autoResize);
    const toggled = new Map(
      targets
        .filter((text) => text.autoResize !== autoResize)
        .map((text) => [text.id, toggleTextAutoResize(text, autoResize)]),
    );

    for (const text of toggled.values()) {
      if (isNonDeletedElement(text)) {
        updateBoundElements(text, app.scene, {
          changedElements: new Map([[text.id, text]]),
        });
      }
    }

    return {
      appState,
      elements: elements.map((element) => toggled.get(element.id) ?? element),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  keyTest: (event, appState, elements) =>
    isTextAutoResizeShortcut(event) &&
    getSelectedFreeTexts(elements, appState).length > 0,
});
