import { describe, expect, it } from "bun:test";

import {
  isInitializedImageElement,
  isLinearElement,
  isTextElement,
} from "../../packages/element/src/typeChecks";

const element = (type: string, extra: Record<string, unknown> = {}) => ({
  id: `${type}-1`,
  type,
  ...extra,
});

describe("element type checks", () => {
  it.each([
    ["text", true],
    ["rectangle", false],
    ["arrow", false],
    ["image", false],
  ])("recognizes text elements (%s)", (type, expected) => {
    expect(isTextElement(element(type))).toBe(expected);
  });

  it.each([
    ["line", true],
    ["arrow", true],
    ["rectangle", false],
    ["freedraw", false],
  ])("recognizes linear elements (%s)", (type, expected) => {
    expect(isLinearElement(element(type))).toBe(expected);
  });

  it("requires a file id for initialized images", () => {
    expect(isInitializedImageElement(element("image"))).toBe(false);
    expect(
      isInitializedImageElement(element("image", { fileId: "file-1" })),
    ).toBe(true);
    expect(isInitializedImageElement(null)).toBe(false);
  });
});
