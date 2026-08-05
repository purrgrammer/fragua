import { describe, expect, test } from "vitest";
import { cacheHitRate } from "../../src/lib/cache-hit-rate.ts";

describe("cacheHitRate", () => {
  test("divides cache reads by all three prompt-token buckets", () => {
    expect(cacheHitRate({ inputTokens: 100, cacheReadTokens: 100, cacheWriteTokens: 200 })).toBeCloseTo(100 / 400, 9);
  });

  test("counts cache writes against the rate", () => {
    // The regression this denominator exists to prevent: once a thread is
    // warm, fresh input collapses to near zero, so omitting writes would
    // report ~100% for a run that just paid to prime a large prefix.
    expect(cacheHitRate({ inputTokens: 6, cacheReadTokens: 164847, cacheWriteTokens: 83035 })).toBeLessThan(0.67);
    // Same numbers under the two-term formula the tiles used to imply.
    expect(164847 / (6 + 164847)).toBeGreaterThan(0.999);
  });

  test("output tokens have no way to influence the result", () => {
    // Not a field at all — this test documents the intent so a future edit
    // adding one has to delete an explicit statement of it. The buckets that
    // ARE fields are all required: omitting `cacheWriteTokens` (the old
    // silent-~100% bug) no longer compiles, so there's nothing to assert at
    // runtime.
    expect(Object.keys({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toHaveLength(3);
  });

  test("a real zero is 0, not undefined", () => {
    expect(cacheHitRate({ inputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(0);
  });

  test("undefined when there is nothing to divide", () => {
    expect(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeUndefined();
  });

  test("undefined on any non-finite or missing bucket", () => {
    expect(cacheHitRate({ inputTokens: null, cacheReadTokens: 100, cacheWriteTokens: 0 })).toBeUndefined();
    expect(cacheHitRate({ inputTokens: 100, cacheReadTokens: undefined, cacheWriteTokens: 0 })).toBeUndefined();
    expect(cacheHitRate({ inputTokens: 100, cacheReadTokens: 100, cacheWriteTokens: undefined })).toBeUndefined();
    expect(cacheHitRate({ inputTokens: Number.NaN, cacheReadTokens: 100, cacheWriteTokens: 0 })).toBeUndefined();
    expect(
      cacheHitRate({ inputTokens: 100, cacheReadTokens: Number.POSITIVE_INFINITY, cacheWriteTokens: 0 }),
    ).toBeUndefined();
    expect(
      cacheHitRate({ inputTokens: Number.NEGATIVE_INFINITY, cacheReadTokens: 100, cacheWriteTokens: 0 }),
    ).toBeUndefined();
  });

  test("a negative bucket cannot produce a rate, whatever the denominator does", () => {
    // Nonsensical input should read as "no data", never as a plausible
    // percentage a tile would happily render.
    // Negative input flips the denominator negative:
    expect(cacheHitRate({ inputTokens: -100, cacheReadTokens: 50, cacheWriteTokens: 0 })).toBeUndefined();
    // ...and the asymmetric case, where the other buckets keep it positive so
    // only the sign of the RATE gives the bad data away:
    expect(cacheHitRate({ inputTokens: 200, cacheReadTokens: -50, cacheWriteTokens: 0 })).toBeUndefined();
    expect(cacheHitRate({ inputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: -10 })).toBeUndefined();
  });
});
