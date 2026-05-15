import { describe, expect, it } from "bun:test";
import { barOuterBounds, STACK_RADIUS_PX } from "../../../src/components/analytics/chart-stack.tsx";

const KEYS = ["a", "b", "c", "d"] as const;
type Key = (typeof KEYS)[number];

describe("barOuterBounds", () => {
  it("exposes the rounding radius", () => {
    expect(STACK_RADIUS_PX).toBe(4);
  });

  it("returns null when the segment has no value", () => {
    expect(barOuterBounds<Key>({ a: 0, b: 0, c: 0, d: 0 }, KEYS, "a", 5, 100, 20, 0)).toBeNull();
  });

  it("returns null when geometry is missing", () => {
    expect(barOuterBounds<Key>({ a: 10, b: 0, c: 0, d: 0 }, KEYS, "a", undefined, 100, 20, 50)).toBeNull();
    expect(barOuterBounds<Key>({ a: 10, b: 0, c: 0, d: 0 }, KEYS, "a", 5, undefined, 20, 50)).toBeNull();
    expect(barOuterBounds<Key>({ a: 10, b: 0, c: 0, d: 0 }, KEYS, "a", 5, 100, 0, 50)).toBeNull();
  });

  it("returns the segment bounds verbatim when it's the only visible segment", () => {
    expect(barOuterBounds<Key>({ a: 10, b: 0, c: 0, d: 0 }, KEYS, "a", 5, 100, 20, 50)).toEqual({
      x: 5,
      y: 100,
      width: 20,
      height: 50,
    });
  });

  it("extends bounds upward from the bottom segment to cover the rest of the stack", () => {
    // a is bottom (10 units, 40 px → 4 px/unit). b is above (6 units →
    // 24 px above a's top). Bar = a + b = 64 px tall, top = 90 - 24 = 66.
    expect(barOuterBounds<Key>({ a: 10, b: 6, c: 0, d: 0 }, KEYS, "a", 5, 90, 20, 40)).toEqual({
      x: 5,
      y: 66,
      width: 20,
      height: 64,
    });
  });

  it("extends bounds downward from the top segment to cover the rest of the stack", () => {
    // d is top (4 units, 16 px → 4 px/unit). a + b + c below (10 units →
    // 40 px below d's bottom). Bar = 4 + 10 = 14 units = 56 px tall,
    // top = d.y = 30 (d is the topmost so valuesAbove = 0).
    expect(barOuterBounds<Key>({ a: 4, b: 4, c: 2, d: 4 }, KEYS, "d", 5, 30, 20, 16)).toEqual({
      x: 5,
      y: 30,
      width: 20,
      height: 56,
    });
  });

  it("extends bounds in both directions for a middle segment", () => {
    // c is in the middle. value = 5, height = 20 → 4 px/unit.
    // valuesAbove (d only) = 3 units → 12 px above.
    // valuesBelow (a + b) = 6 units → 24 px below.
    // Bar height = 12 + 20 + 24 = 56 px, top = c.y - 12 = 50 - 12 = 38.
    expect(barOuterBounds<Key>({ a: 2, b: 4, c: 5, d: 3 }, KEYS, "c", 5, 50, 20, 20)).toEqual({
      x: 5,
      y: 38,
      width: 20,
      height: 56,
    });
  });

  it("agrees on bar bounds across every segment of the same bar", () => {
    // The clip-path approach hinges on every segment in a bar reporting
    // the same outer bounds. Verify with a four-segment stack at scale
    // 4 px/unit: a=2 (8 px), b=4 (16 px), c=5 (20 px), d=3 (12 px).
    // Bar total = 14 units = 56 px. Top = baseline - 56.
    const baseline = 100;
    const row = { a: 2, b: 4, c: 5, d: 3 } as const;
    const segs = {
      a: { y: baseline - 8, h: 8 },
      b: { y: baseline - 8 - 16, h: 16 },
      c: { y: baseline - 8 - 16 - 20, h: 20 },
      d: { y: baseline - 8 - 16 - 20 - 12, h: 12 },
    };
    const bounds = (KEYS as readonly Key[]).map((k) => barOuterBounds<Key>(row, KEYS, k, 5, segs[k].y, 20, segs[k].h));
    const expected = { x: 5, y: baseline - 56, width: 20, height: 56 };
    for (const b of bounds) expect(b).toEqual(expected);
  });

  it("ignores negative or NaN payload entries defensively", () => {
    // valuesAbove/valuesBelow clamp to 0 — a corrupt sibling shouldn't
    // skew the bar bounds.
    const row = { a: 10, b: -5, c: 0, d: Number.NaN } as Record<Key, number>;
    expect(barOuterBounds<Key>(row, KEYS, "a", 5, 100, 20, 40)).toEqual({
      x: 5,
      y: 100,
      width: 20,
      height: 40,
    });
  });
});
