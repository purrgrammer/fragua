import { describe, expect, test } from "vitest";
import { formatCacheHitRate } from "./format.ts";

describe("formatCacheHitRate", () => {
  // ── zero-denominator cases ──────────────────────────────────────

  test("returns — when all buckets are 0", () => {
    expect(formatCacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe("—");
    // Every bucket is required — `cacheWriteTokens` used to default to 0 and
    // silently produce the warm-thread ~100% reading.
    expect(formatCacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: undefined })).toBe("—");
  });

  // ── null / undefined buckets ────────────────────────────────────

  test("returns — when cacheReadTokens is null", () => {
    expect(formatCacheHitRate({ inputTokens: 100, cacheReadTokens: null, cacheWriteTokens: 0 })).toBe("—");
  });

  test("returns — when inputTokens is undefined", () => {
    expect(formatCacheHitRate({ inputTokens: undefined, cacheReadTokens: 50, cacheWriteTokens: 0 })).toBe("—");
  });

  test("returns — when two buckets are undefined", () => {
    expect(formatCacheHitRate({ inputTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: 0 })).toBe("—");
  });

  test("returns — when cacheWriteTokens is null", () => {
    expect(formatCacheHitRate({ inputTokens: 100, cacheReadTokens: 100, cacheWriteTokens: null })).toBe("—");
  });

  test("returns — when cacheWriteTokens is NaN", () => {
    expect(formatCacheHitRate({ inputTokens: 100, cacheReadTokens: 100, cacheWriteTokens: Number.NaN })).toBe("—");
  });

  // ── non-finite and negative guards ──────────────────────────────

  test("returns — for Infinity cacheReadTokens", () => {
    expect(formatCacheHitRate({ inputTokens: 0, cacheReadTokens: Number.POSITIVE_INFINITY, cacheWriteTokens: 0 })).toBe(
      "—",
    );
  });

  test("returns — for negative Infinity inputTokens", () => {
    expect(
      formatCacheHitRate({ inputTokens: Number.NEGATIVE_INFINITY, cacheReadTokens: 100, cacheWriteTokens: 0 }),
    ).toBe("—");
  });

  test("returns — for NaN cacheReadTokens", () => {
    expect(formatCacheHitRate({ inputTokens: 100, cacheReadTokens: Number.NaN, cacheWriteTokens: 0 })).toBe("—");
  });

  test("returns — for NaN inputTokens", () => {
    expect(formatCacheHitRate({ inputTokens: Number.NaN, cacheReadTokens: 50, cacheWriteTokens: 0 })).toBe("—");
  });

  test("returns — for a negative bucket the denominator would hide", () => {
    expect(formatCacheHitRate({ inputTokens: 200, cacheReadTokens: -50, cacheWriteTokens: 0 })).toBe("—");
  });

  // ── the three-bucket formula ────────────────────────────────────

  test("includes cacheWriteTokens in the denominator (the bug fix)", () => {
    // Pre-fix would have been 100 / (100 + 0) = 100% — misleadingly high.
    // Post-fix: 100 / (100 + 0 + 200) = 33.3% — accurately reflects that
    // we paid cache-write rates on 200 tokens that we only read 100 of.
    expect(formatCacheHitRate({ inputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 200 })).toBe("33.3%");
  });

  test("realistic warm-thread shape (the failure case)", () => {
    // Snapshot from a real llm turn. Pre-fix denom = 164853 → 99.99% →
    // "100.0%" displayed. Post-fix denom = 247888 → ~66.5%.
    expect(formatCacheHitRate({ inputTokens: 6, cacheReadTokens: 164847, cacheWriteTokens: 83035 })).toBe("66.5%");
  });

  // ── formatting (whole vs. fractional) ───────────────────────────

  test("renders whole percentages without a trailing .0", () => {
    // 100 / (100 + 0 + 0) = 100% → "100%", not "100.0%"
    expect(formatCacheHitRate({ inputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 0 })).toBe("100%");
    // 0 / (500 + 0 + 0) = 0% → "0%", not "0.0%"
    expect(formatCacheHitRate({ inputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe("0%");
  });

  test("renders fractional percentages with one decimal", () => {
    // 1 / (2 + 1 + 0) = 0.333… → "33.3%"
    expect(formatCacheHitRate({ inputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 })).toBe("33.3%");
  });

  test("rounds to one decimal place", () => {
    // 100 / 900 = 11.111…% → "11.1%"
    expect(formatCacheHitRate({ inputTokens: 800, cacheReadTokens: 100, cacheWriteTokens: 0 })).toBe("11.1%");
  });
});
