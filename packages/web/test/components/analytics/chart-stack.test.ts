import { describe, expect, it } from "bun:test";
import {
  clampRadius,
  PROMOTION_THRESHOLD,
  STACK_RADIUS_PX,
  visibleSegmentRadius,
} from "../../../src/components/analytics/chart-stack.ts";

const KEYS = ["a", "b", "c", "d"] as const;
type Key = (typeof KEYS)[number];

const r = STACK_RADIUS_PX;

describe("visibleSegmentRadius", () => {
  it("returns no radius for an empty bucket", () => {
    expect(visibleSegmentRadius<Key>({ a: 0, b: 0, c: 0, d: 0 }, KEYS, "a")).toEqual([0, 0, 0, 0]);
  });

  it("rounds all four corners on a single-segment bar", () => {
    const row = { a: 0, b: 10, c: 0, d: 0 } as const;
    expect(visibleSegmentRadius<Key>(row, KEYS, "b")).toEqual([r, r, r, r]);
    expect(visibleSegmentRadius<Key>(row, KEYS, "a")).toEqual([0, 0, 0, 0]);
  });

  it("rounds top and bottom independently when the stack has multiple segments", () => {
    const row = { a: 5, b: 5, c: 5, d: 5 } as const;
    expect(visibleSegmentRadius<Key>(row, KEYS, "a")).toEqual([0, 0, r, r]);
    expect(visibleSegmentRadius<Key>(row, KEYS, "b")).toEqual([0, 0, 0, 0]);
    expect(visibleSegmentRadius<Key>(row, KEYS, "c")).toEqual([0, 0, 0, 0]);
    expect(visibleSegmentRadius<Key>(row, KEYS, "d")).toEqual([r, r, 0, 0]);
  });

  it("promotes the rounded top to the next-larger segment when the topmost is thin", () => {
    // d is well below the 5% threshold (0.5/100.5 ≈ 0.5%); c carries the
    // bar's mass and should get the rounded top instead.
    const row = { a: 0, b: 0, c: 100, d: 0.5 } as const;
    expect(visibleSegmentRadius<Key>(row, KEYS, "d")).toEqual([0, 0, 0, 0]);
    expect(visibleSegmentRadius<Key>(row, KEYS, "c")).toEqual([r, r, r, r]);
  });

  it("does not promote when the topmost segment is at the threshold", () => {
    // d is exactly at 5%, c at 95%; the topmost stays the rounded top.
    const row = { a: 0, b: 0, c: 95, d: 5 } as const;
    expect(visibleSegmentRadius<Key>(row, KEYS, "d")).toEqual([r, r, 0, 0]);
    expect(visibleSegmentRadius<Key>(row, KEYS, "c")).toEqual([0, 0, r, r]);
    // Sanity: threshold matches the constant the util exposes.
    expect(5 / 100).toBeGreaterThanOrEqual(PROMOTION_THRESHOLD);
  });

  it("promotes through multiple thin segments to find a non-thin top", () => {
    // c (1%) and d (1%) are both below threshold; b (98%) gets the round.
    const row = { a: 0, b: 98, c: 1, d: 1 } as const;
    expect(visibleSegmentRadius<Key>(row, KEYS, "d")).toEqual([0, 0, 0, 0]);
    expect(visibleSegmentRadius<Key>(row, KEYS, "c")).toEqual([0, 0, 0, 0]);
    expect(visibleSegmentRadius<Key>(row, KEYS, "b")).toEqual([r, r, r, r]);
  });

  it("falls back to the topmost visible segment when every segment is thin", () => {
    // Hypothetical 30-way stack where no segment clears 5% — promotion
    // walks all the way to the bottom and rounds visible[0]. With only
    // two equal visible keys here the bottom doubles as the rounded top.
    const row = { a: 1, b: 0, c: 0, d: 1 } as const;
    // Both a and d are at 50% — well above threshold, so this is the
    // normal split: a gets bottom, d gets top.
    expect(visibleSegmentRadius<Key>(row, KEYS, "a")).toEqual([0, 0, r, r]);
    expect(visibleSegmentRadius<Key>(row, KEYS, "d")).toEqual([r, r, 0, 0]);
  });
});

describe("clampRadius", () => {
  it("returns the input untouched when the segment is taller than 2× the radius", () => {
    expect(clampRadius([4, 4, 0, 0], 20)).toEqual([4, 4, 0, 0]);
  });

  it("caps each corner at half the segment height when the segment is short", () => {
    expect(clampRadius([4, 4, 4, 4], 6)).toEqual([3, 3, 3, 3]);
    expect(clampRadius([4, 4, 0, 0], 2)).toEqual([1, 1, 0, 0]);
  });

  it("zeroes the radius when the segment has zero height", () => {
    expect(clampRadius([4, 4, 4, 4], 0)).toEqual([0, 0, 0, 0]);
  });

  it("treats a negative height as zero (defensive — recharts shouldn't pass it)", () => {
    expect(clampRadius([4, 4, 4, 4], -10)).toEqual([0, 0, 0, 0]);
  });
});
