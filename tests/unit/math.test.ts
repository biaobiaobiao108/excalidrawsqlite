import { describe, expect, it } from "bun:test";

import {
  degreesToRadians,
  ellipse,
  ellipseIncludesPoint,
  pointCenter,
  pointDistance,
  pointFrom,
  pointRotateDegs,
  pointTranslate,
  rangeInclusive,
  rangeIncludesValue,
  rangeIntersection,
  rangesOverlap,
  vectorAdd,
  vectorCross,
  vectorMagnitude,
  vectorNormalize,
} from "../../packages/math/src/index";

const expectClose = (actual: number, expected: number, precision = 8) => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(10 ** -precision);
};

describe("math primitives", () => {
  it("translates, centers, rotates and measures points", () => {
    const point = pointFrom(10, 5);

    expect(pointTranslate(point, [2, -3])).toEqual([12, 2]);
    expect(pointCenter(point, [0, 1])).toEqual([5, 3]);
    expect(pointDistance(point, [13, 9])).toBe(5);
    const rotated = pointRotateDegs(point, [0, 0], 90);
    expectClose(rotated[0], -5);
    expectClose(rotated[1], 10);
  });

  it("performs vector operations without mutating their inputs", () => {
    const first = [3, 4] as const;
    const second = [-1, 2] as const;

    expect(vectorAdd(first, second)).toEqual([2, 6]);
    expect(vectorCross(first, second)).toBe(10);
    expect(vectorMagnitude(first)).toBe(5);
    expect(vectorNormalize(first)).toEqual([0.6, 0.8]);
    expect(first).toEqual([3, 4]);
  });

  it.each([
    { degrees: 0, radians: 0 },
    { degrees: 90, radians: Math.PI / 2 },
    { degrees: 180, radians: Math.PI },
    { degrees: -45, radians: -Math.PI / 4 },
  ])("converts $degrees degrees to radians", ({ degrees, radians }) => {
    expectClose(degreesToRadians(degrees), radians);
  });

  it("handles inclusive range boundaries and intersections", () => {
    const first = rangeInclusive(1, 5);
    const second = rangeInclusive(5, 8);

    expect(rangesOverlap(first, second)).toBe(true);
    expect(rangeIntersection(first, second)).toEqual([5, 5]);
    expect(rangeIncludesValue(1, first)).toBe(true);
    expect(rangeIncludesValue(6, first)).toBe(false);
  });

  it("checks points against an ellipse", () => {
    const shape = ellipse(pointFrom(10, 10), 4, 2);

    expect(ellipseIncludesPoint(shape, pointFrom(10, 10))).toBe(true);
    expect(ellipseIncludesPoint(shape, pointFrom(14, 10))).toBe(true);
    expect(ellipseIncludesPoint(shape, pointFrom(15, 10))).toBe(false);
  });
});
