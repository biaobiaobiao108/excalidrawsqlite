import { describe, expect, it } from "bun:test";

import {
  getEllipseShape,
  pointInEllipse,
  pointOnEllipse,
} from "../../packages/utils/src/shape";

const ellipseElement = {
  type: "ellipse" as const,
  x: 10,
  y: 20,
  width: 40,
  height: 20,
  angle: 0,
};

describe("pure shape utilities", () => {
  it("converts an ellipse element into a geometric shape", () => {
    expect(getEllipseShape(ellipseElement as any)).toEqual({
      type: "ellipse",
      data: {
        center: [30, 30] as any,
        angle: 0 as any,
        halfWidth: 20,
        halfHeight: 10,
      },
    });
  });

  it.each([
    { point: [30, 30], inside: true },
    { point: [50, 30], inside: true },
    { point: [51, 30], inside: false },
    { point: [30, 41], inside: false },
  ])("checks ellipse containment for $point", ({ point, inside }) => {
    expect(
      pointInEllipse(
        point as any,
        getEllipseShape(ellipseElement as any).data as any,
      ),
    ).toBe(inside);
  });

  it("finds a point on the rotated ellipse boundary", () => {
    const shape = getEllipseShape({
      ...ellipseElement,
      angle: Math.PI / 2,
    } as any);
    expect(pointOnEllipse([30, 50] as any, shape.data as any)).toBe(true);
    expect(pointOnEllipse([50, 30] as any, shape.data as any)).toBe(false);
  });
});
