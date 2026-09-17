import { describe, expect, it } from "bun:test";

import { BinaryHeap } from "../../packages/common/src/binary-heap";
import { isBounds } from "../../packages/common/src/bounds";
import {
  FONT_FAMILY,
  LXGW_WENKAI_FONT,
  SOURCE_HAN_SANS_FONT,
} from "../../packages/common/src/constants";
import { FONT_METADATA } from "../../packages/common/src/font-metadata";
import { getFontFamilyString } from "../../packages/common/src/utils";

describe("common primitives", () => {
  it("keeps BinaryHeap values ordered by score", () => {
    const heap = new BinaryHeap<number>((value) => value);

    [7, 1, 9, 3, 2].forEach((value) => heap.push(value));

    expect(heap.size()).toBe(5);
    expect([heap.pop(), heap.pop(), heap.pop(), heap.pop(), heap.pop()]).toEqual([
      1,
      2,
      3,
      7,
      9,
    ]);
    expect(heap.pop()).toBeNull();
  });

  it.each([
    [[0, 0, 10, 10], true],
    [[-5, 1, 2, 8], true],
    [[0, 0, 0], false],
    ["0,0,10,10", false],
  ])("validates bounds (%s)", (value, expected) => {
    expect(isBounds(value)).toBe(expected);
  });

  it("uses the CDN family name for LXGW WenKai", () => {
    expect(
      getFontFamilyString({ fontFamily: FONT_FAMILY[LXGW_WENKAI_FONT] }),
    ).toBe("LXGW WenKai, sans-serif, Segoe UI Emoji");
  });

  it("uses the CDN family name for Source Han Sans", () => {
    expect(
      getFontFamilyString({
        fontFamily: FONT_FAMILY[SOURCE_HAN_SANS_FONT],
      }),
    ).toBe("Source Han Sans SC VF, sans-serif, Segoe UI Emoji");
  });

  it("keeps Source Han Sans metrics available for text layout", () => {
    expect(FONT_METADATA[FONT_FAMILY[SOURCE_HAN_SANS_FONT]]?.metrics).toEqual({
      unitsPerEm: 1000,
      ascender: 1160,
      descender: -288,
      lineHeight: 1.25,
    });
  });

  it("uses system fallbacks for unsupported Excalifont glyphs", () => {
    expect(
      getFontFamilyString({ fontFamily: FONT_FAMILY.Excalifont }),
    ).toBe("Excalifont, sans-serif, Segoe UI Emoji");
  });
});
