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

import type {
  Degrees,
  GlobalPoint,
  InclusiveRange,
  Vector,
} from "../../packages/math/src/types";

const expectClose = (actual: number, expected: number, precision = 8) => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(10 ** -precision);
};

describe("math primitives", () => {
  it("translates, centers, rotates and measures points", () => {
    const point = pointFrom(10, 5);

    expect(pointTranslate(point, [2, -3] as Vector)).toEqual([12, 2] as any);
    expect(pointCenter(point, pointFrom<GlobalPoint>(0, 1))).toEqual(
      [5, 3] as any,
    );
    expect(pointDistance(point, pointFrom<GlobalPoint>(13, 9))).toBe(5);
    const rotated = pointRotateDegs(
      point,
      pointFrom<GlobalPoint>(0, 0),
      90 as Degrees,
    );
    expectClose(rotated[0], -5);
    expectClose(rotated[1], 10);
  });

  it("performs vector operations without mutating their inputs", () => {
    const first = [3, 4] as Vector;
    const second = [-1, 2] as Vector;

    expect(vectorAdd(first, second)).toEqual([2, 6] as any);
    expect(vectorCross(first, second)).toBe(10);
    expect(vectorMagnitude(first)).toBe(5);
    expect(vectorNormalize(first)).toEqual([0.6, 0.8] as any);
    expect(first).toEqual([3, 4] as any);
  });

  it.each([
    { degrees: 0, radians: 0 },
    { degrees: 90, radians: Math.PI / 2 },
    { degrees: 180, radians: Math.PI },
    { degrees: -45, radians: -Math.PI / 4 },
  ])("converts $degrees degrees to radians", ({ degrees, radians }) => {
    expectClose(degreesToRadians(degrees as Degrees), radians);
  });

  it("handles inclusive range boundaries and intersections", () => {
    const first = rangeInclusive(1, 5);
    const second = rangeInclusive(5, 8);

    expect(rangesOverlap(first, second)).toBe(true);
    expect(rangeIntersection(first, second)).toEqual(
      [5, 5] as unknown as InclusiveRange,
    );
    expect(rangeIncludesValue(1, first)).toBe(true);
    expect(rangeIncludesValue(6, first)).toBe(false);
  });

  it("checks points against an ellipse", () => {
    const shape = ellipse(pointFrom(10, 10), 4, 2);

    expect(ellipseIncludesPoint(pointFrom(10, 10), shape)).toBe(true);
    expect(ellipseIncludesPoint(pointFrom(14, 10), shape)).toBe(true);
    expect(ellipseIncludesPoint(pointFrom(15, 10), shape)).toBe(false);
  });
});
