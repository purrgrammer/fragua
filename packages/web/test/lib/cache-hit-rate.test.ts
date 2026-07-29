import { describe, expect, test } from "vitest";
import { cacheHitRate } from "../../src/lib/cache-hit-rate.ts";

describe("cacheHitRate", () => {
  test("divides cache reads by all three prompt-token buckets", () => {
    expect(cacheHitRate(100, 100, 200)).toBeCloseTo(100 / 400, 9);
  });

  test("counts cache writes against the rate", () => {
    // The regression this denominator exists to prevent: once a thread is
    // warm, fresh input collapses to near zero, so omitting writes would
    // report ~100% for a run that just paid to prime a large prefix.
    expect(cacheHitRate(6, 164847, 83035)).toBeLessThan(0.67);
    // Same numbers under the two-term formula the tiles used to imply.
    expect(164847 / (6 + 164847)).toBeGreaterThan(0.999);
  });

  test("output tokens have no way to influence the result", () => {
    // Not an argument at all — this test documents the intent so a future
    // edit adding one has to delete an explicit statement of it.
    expect(cacheHitRate.length).toBe(3);
  });

  test("a real zero is 0, not undefined", () => {
    expect(cacheHitRate(500, 0, 0)).toBe(0);
  });

  test("undefined when there is nothing to divide", () => {
    expect(cacheHitRate(0, 0, 0)).toBeUndefined();
  });

  test("undefined on any non-finite or missing input", () => {
    expect(cacheHitRate(null, 100, 0)).toBeUndefined();
    expect(cacheHitRate(100, undefined, 0)).toBeUndefined();
    expect(cacheHitRate(100, 100, undefined)).toBeUndefined();
    expect(cacheHitRate(Number.NaN, 100, 0)).toBeUndefined();
    expect(cacheHitRate(100, Number.POSITIVE_INFINITY, 0)).toBeUndefined();
    expect(cacheHitRate(Number.NEGATIVE_INFINITY, 100, 0)).toBeUndefined();
  });

  test("negative totals cannot produce a rate", () => {
    // Nonsensical input should read as "no data", never as a plausible
    // percentage a tile would happily render.
    expect(cacheHitRate(-100, 50, 0)).toBeUndefined();
  });
});
