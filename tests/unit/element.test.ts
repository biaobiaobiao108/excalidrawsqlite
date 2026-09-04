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
    expect(isTextElement(element(type) as any)).toBe(expected);
  });

  it.each([
    ["line", true],
    ["arrow", true],
    ["rectangle", false],
    ["freedraw", false],
  ])("recognizes linear elements (%s)", (type, expected) => {
    expect(isLinearElement(element(type) as any)).toBe(expected);
  });

  it("requires a file id for initialized images", () => {
    expect(isInitializedImageElement(element("image") as any)).toBe(false);
    expect(
      isInitializedImageElement(
        element("image", { fileId: "file-1" }) as any,
      ),
    ).toBe(true);
    expect(isInitializedImageElement(null)).toBe(false);
  });
});
