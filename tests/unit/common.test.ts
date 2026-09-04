import { describe, expect, it } from "bun:test";

import { BinaryHeap } from "../../packages/common/src/binary-heap";
import { colorToHex, normalizeInputColor, rgbToHex } from "../../packages/common/src/colors";
import { Queue } from "../../packages/common/src/queue";
import { normalizeLink } from "../../packages/common/src/url";

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

  it("runs queued jobs sequentially and preserves results", async () => {
    const queue = new Queue();
    const events: string[] = [];

    const first = queue.push(async (value: string) => {
      events.push(`start:${value}`);
      await Promise.resolve();
      events.push(`end:${value}`);
      return value.length;
    }, "first");
    const second = queue.push((value: string) => {
      events.push(`run:${value}`);
      return value.length;
    }, "second");

    expect(await Promise.all([first, second])).toEqual([5, 6]);
    expect(events).toEqual([
      "start:first",
      "end:first",
      "run:second",
    ]);
  });

  it.each([
    ["#123456", "#123456"],
    ["rgb(255, 0, 16)", "#ff0010"],
    ["rgba(255, 0, 16, 0.5)", "#ff001080"],
  ])("normalizes %s colors", (input, expected) => {
    expect(colorToHex(input)).toBe(expected);
  });

  it("keeps valid CSS colors stable while normalizing hex input", () => {
    expect(normalizeInputColor("  #123456  ")).toBe("#123456");
    expect(normalizeInputColor("123456")).toBe("#123456");
    expect(normalizeInputColor("transparent")).toBe("transparent");
    expect(normalizeInputColor("not-a-color")).toBeNull();
  });

  it("formats RGB values with optional alpha", () => {
    expect(rgbToHex(0, 128, 255)).toBe("#0080ff");
    expect(rgbToHex(0, 128, 255, 0.5)).toBe("#0080ff80");
  });

  it("normalizes links without rewriting their path", () => {
    expect(normalizeLink("  https://example.com/diagram  ")).toBe(
      "https://example.com/diagram",
    );
  });
});
