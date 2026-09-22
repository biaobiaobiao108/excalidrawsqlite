import {
  getCommonFrameId,
  getFrameChildrenInsertionIndex,
  getElementBounds,
} from "@excalidraw/element";

import {
  arrayToMap,
  memoize,
  toBrandedType,
  viewportCoordsToSceneCoords,
} from "@excalidraw/common";

import type {
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  NonDeleted,
  NonDeletedElementsMap,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import type { Scene } from "@excalidraw/element";

import { renderStaticSceneThrottled } from "../renderer/staticScene";

import type { RenderableElementsMap } from "./types";

import type { AppState } from "../types";

type GetRenderableElementsOpts = {
  zoom: AppState["zoom"];
  offsetLeft: AppState["offsetLeft"];
  offsetTop: AppState["offsetTop"];
  scrollX: AppState["scrollX"];
  scrollY: AppState["scrollY"];
  height: AppState["height"];
  width: AppState["width"];
  editingTextElement: AppState["editingTextElement"];
  newElement: AppState["newElement"];
  selectedElements: readonly NonDeletedExcalidrawElement[];
  selectedElementsAreBeingDragged: AppState["selectedElementsAreBeingDragged"];
  frameToHighlight: AppState["frameToHighlight"];
};

type ElementBounds = readonly [number, number, number, number];

type VisibleElementIndex = {
  elementsMap: NonDeletedElementsMap;
  buckets: Map<string, NonDeletedExcalidrawElement[]>;
  largeElements: NonDeletedExcalidrawElement[];
  order: Map<string, number>;
  bounds: Map<string, ElementBounds>;
};

const VISIBLE_INDEX_MIN_ELEMENTS = 300;
const VISIBLE_INDEX_CELL_SIZE = 1024;
const VISIBLE_INDEX_MAX_QUERY_CELLS = 256;
const VISIBLE_INDEX_MAX_ELEMENT_CELLS = 256;

const getCellKey = (x: number, y: number) => `${x}:${y}`;

const getCellRange = (x1: number, y1: number, x2: number, y2: number) => ({
  minX: Math.floor(x1 / VISIBLE_INDEX_CELL_SIZE),
  minY: Math.floor(y1 / VISIBLE_INDEX_CELL_SIZE),
  maxX: Math.floor(x2 / VISIBLE_INDEX_CELL_SIZE),
  maxY: Math.floor(y2 / VISIBLE_INDEX_CELL_SIZE),
});

export class Renderer {
  private scene: Scene;
  private visibleElementIndex: VisibleElementIndex | null = null;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  private getVisibleCanvasElements({
    elementsMap,
    zoom,
    offsetLeft,
    offsetTop,
    scrollX,
    scrollY,
    height,
    width,
  }: {
    elementsMap: NonDeletedElementsMap;
    zoom: AppState["zoom"];
    offsetLeft: AppState["offsetLeft"];
    offsetTop: AppState["offsetTop"];
    scrollX: AppState["scrollX"];
    scrollY: AppState["scrollY"];
    height: AppState["height"];
    width: AppState["width"];
  }): readonly NonDeletedExcalidrawElement[] {
    const viewTransformations = {
      zoom,
      offsetLeft,
      offsetTop,
      scrollX,
      scrollY,
    };
    const topLeftSceneCoords = viewportCoordsToSceneCoords(
      { clientX: offsetLeft, clientY: offsetTop },
      viewTransformations,
    );
    const bottomRightSceneCoords = viewportCoordsToSceneCoords(
      { clientX: offsetLeft + width, clientY: offsetTop + height },
      viewTransformations,
    );
    const visibleBounds = [
      topLeftSceneCoords.x,
      topLeftSceneCoords.y,
      bottomRightSceneCoords.x,
      bottomRightSceneCoords.y,
    ] as const;

    const candidates: Iterable<NonDeletedExcalidrawElement> =
      elementsMap.size >= VISIBLE_INDEX_MIN_ELEMENTS
        ? this.getVisibleElementCandidates(elementsMap, visibleBounds)
        : elementsMap.values();

    const visibleElements: NonDeletedExcalidrawElement[] = [];
    const indexedBounds = this.visibleElementIndex?.elementsMap === elementsMap
      ? this.visibleElementIndex.bounds
      : null;
    for (const element of candidates) {
      const [x1, y1, x2, y2] =
        indexedBounds?.get(element.id) || getElementBounds(element, elementsMap);
      if (
        topLeftSceneCoords.x <= x2 &&
        topLeftSceneCoords.y <= y2 &&
        bottomRightSceneCoords.x >= x1 &&
        bottomRightSceneCoords.y >= y1
      ) {
        visibleElements.push(element);
      }
    }
    return visibleElements;
  }

  private getVisibleElementCandidates = (
    elementsMap: NonDeletedElementsMap,
    visibleBounds: readonly [number, number, number, number],
  ): readonly NonDeletedExcalidrawElement[] => {
    if (this.visibleElementIndex?.elementsMap !== elementsMap) {
      const buckets = new Map<string, NonDeletedExcalidrawElement[]>();
      const largeElements: NonDeletedExcalidrawElement[] = [];
      const order = new Map<string, number>();
      const bounds = new Map<string, ElementBounds>();

      let elementIndex = 0;
      for (const element of elementsMap.values()) {
        const elementBounds = getElementBounds(element, elementsMap);
        bounds.set(element.id, elementBounds);
        order.set(element.id, elementIndex++);
        const range = getCellRange(...elementBounds);
        const cellCount =
          (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
        if (cellCount > VISIBLE_INDEX_MAX_ELEMENT_CELLS) {
          largeElements.push(element);
          continue;
        }
        for (let x = range.minX; x <= range.maxX; x += 1) {
          for (let y = range.minY; y <= range.maxY; y += 1) {
            const key = getCellKey(x, y);
            const bucket = buckets.get(key);
            if (bucket) {
              bucket.push(element);
            } else {
              buckets.set(key, [element]);
            }
          }
        }
      }

      this.visibleElementIndex = {
        elementsMap,
        buckets,
        largeElements,
        order,
        bounds,
      };
    }

    const index = this.visibleElementIndex;
    if (!index) {
      return [...elementsMap.values()];
    }
    const range = getCellRange(...visibleBounds);
    const queryCellCount =
      (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
    if (queryCellCount > VISIBLE_INDEX_MAX_QUERY_CELLS) {
      return [...elementsMap.values()];
    }

    const candidates = new Set<NonDeletedExcalidrawElement>(
      index.largeElements,
    );
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        for (const element of index.buckets.get(getCellKey(x, y)) || []) {
          candidates.add(element);
        }
      }
    }
    return [...candidates].sort(
      (left, right) => index.order.get(left.id)! - index.order.get(right.id)!,
    );
  };

  private getRenderableElementsMap({
    elements,
    editingTextElement,
    newElement,
  }: {
    elements: readonly NonDeletedExcalidrawElement[];
    editingTextElement: AppState["editingTextElement"];
    newElement: AppState["newElement"];
  }) {
    const elementsMap = toBrandedType<RenderableElementsMap>(new Map());
    const newElementCanvasElement = newElement?.frameId ? null : newElement;

    for (const element of elements) {
      if (newElementCanvasElement?.id === element.id) {
        continue;
      }

      // we don't want to render text element that's being currently edited
      // (it's rendered on remote only)
      if (
        !editingTextElement ||
        editingTextElement.type !== "text" ||
        element.id !== editingTextElement.id
      ) {
        elementsMap.set(element.id, element);
      }
    }
    return { elementsMap, newElementCanvasElement };
  }

  private _getRenderableElementsMap = memoize(
    ({
      canvasNonce,
      editingTextElement,
      newElement,
    }: {
      canvasNonce: string;
      editingTextElement: AppState["editingTextElement"];
      newElement: AppState["newElement"];
    }) => {
      void canvasNonce;
      return this.getRenderableElementsMap({
        elements: this.scene.getNonDeletedElements(),
        editingTextElement,
        newElement,
      });
    },
  );

  private sortSelectedElementsIntoHighlightedFrame<
    T extends ExcalidrawElement,
  >({
    visibleElements,
    selectedElements,
    frameToHighlight,
  }: {
    selectedElements: readonly NonDeletedExcalidrawElement[];
    visibleElements: readonly T[];
    frameToHighlight: NonDeleted<ExcalidrawFrameLikeElement>;
  }): readonly T[] {
    if (!selectedElements.length) {
      return visibleElements;
    }

    // we assume all selected elements are eligible frame children if
    // frameToHighlight is defined
    const selectedElementsMap = arrayToMap(selectedElements);

    // thus, all deselected elements are the ones we won't reorder
    const deselectedElements = visibleElements.filter(
      (element) => !selectedElementsMap.has(element.id),
    );

    const insertionIndex = getFrameChildrenInsertionIndex(
      deselectedElements,
      frameToHighlight.id,
    );

    if (insertionIndex === null) {
      return visibleElements;
    }

    return [
      ...deselectedElements.slice(0, insertionIndex),
      ...selectedElements,
      ...deselectedElements.slice(insertionIndex),
    ] as readonly T[];
  }

  private _getRenderableElements = memoize(
    ({
      canvasNonce,
      zoom,
      offsetLeft,
      offsetTop,
      scrollX,
      scrollY,
      height,
      width,
      editingTextElement,
      newElement,
    }: Omit<
      GetRenderableElementsOpts,
      | "selectedElements"
      | "selectedElementsAreBeingDragged"
      | "frameToHighlight"
    > & {
      canvasNonce: string;
    }) => {
      const { elementsMap, newElementCanvasElement } =
        this._getRenderableElementsMap({
          canvasNonce,
          editingTextElement,
          newElement,
        });

      const visibleElements = this.getVisibleCanvasElements({
        elementsMap,
        zoom,
        offsetLeft,
        offsetTop,
        scrollX,
        scrollY,
        height,
        width,
      });

      return {
        elementsMap,
        visibleElements,
        newElementCanvasElement,
        canvasNonce,
      };
    },
  );

  public getRenderableElements = (opts: GetRenderableElementsOpts) => {
    const { newElement } = opts;
    const canvasNonce = `${this.scene.getSceneNonce()}${
      newElement?.frameId ? `:${newElement.versionNonce}` : ""
    }`;

    const ret = this._getRenderableElements({
      canvasNonce,

      // don't spread `opts` because we don't want to memoize on some props

      zoom: opts.zoom,
      offsetLeft: opts.offsetLeft,
      offsetTop: opts.offsetTop,
      scrollX: opts.scrollX,
      scrollY: opts.scrollY,
      height: opts.height,
      width: opts.width,
      editingTextElement: opts.editingTextElement,
      newElement: opts.newElement,
    });

    // if we're dragging elements over a frame, reorder the selected elements
    // inside the frame during render (we don't set the `element.frameId` until
    // pointerup else we'd have to painstainly restore the orig index if user
    // didn't end up adding elements to the frame)
    if (
      opts.frameToHighlight &&
      opts.selectedElementsAreBeingDragged &&
      // if all dragged elements are already in the frame, don't reorder
      getCommonFrameId(opts.selectedElements) !== opts.frameToHighlight.id
    ) {
      const reorderedVisibleElements =
        this.sortSelectedElementsIntoHighlightedFrame({
          visibleElements: ret.visibleElements,
          selectedElements: opts.selectedElements,
          frameToHighlight: opts.frameToHighlight,
        });

      return {
        ...ret,
        visibleElements: reorderedVisibleElements,
      };
    }

    return ret;
  };

  // NOTE Doesn't destroy everything (scene, rc, etc.) because it may not be
  // safe to break TS contract here (for upstream cases)
  public destroy() {
    renderStaticSceneThrottled.cancel();
    this._getRenderableElements.clear();
    this._getRenderableElementsMap.clear();
    this.visibleElementIndex = null;
  }
}
