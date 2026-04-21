import { describe, expect, test } from "bun:test";
import { formatCacheHitRate } from "./format.ts";

describe("formatCacheHitRate", () => {
  // ── zero-denominator cases ──────────────────────────────────────

  test("returns — when both inputs are 0", () => {
    expect(formatCacheHitRate(0, 0)).toBe("—");
  });

  test("returns — when cacheRead is 0 and input is 0", () => {
    // redundant but explicit per spec
    expect(formatCacheHitRate(0, 0)).toBe("—");
  });

  // ── null / undefined inputs ─────────────────────────────────────

  test("returns — when cacheRead is null", () => {
    expect(formatCacheHitRate(null, 100)).toBe("—");
  });

  test("returns — when inputTokens is undefined", () => {
    expect(formatCacheHitRate(50, undefined)).toBe("—");
  });

  test("returns — when both arguments are undefined", () => {
    expect(formatCacheHitRate(undefined, undefined)).toBe("—");
  });

  // ── non-finite guards ───────────────────────────────────────────

  test("returns — for Infinity cacheRead", () => {
    expect(formatCacheHitRate(Number.POSITIVE_INFINITY, 0)).toBe("—");
  });

  test("returns — for negative Infinity input", () => {
    expect(formatCacheHitRate(100, Number.NEGATIVE_INFINITY)).toBe("—");
  });

  test("returns — for NaN cacheRead", () => {
    expect(formatCacheHitRate(Number.NaN, 100)).toBe("—");
  });

  test("returns — for NaN inputTokens", () => {
    expect(formatCacheHitRate(50, Number.NaN)).toBe("—");
  });

  // ── correct one-decimal rounding ────────────────────────────────

  test("computes 10.0% correctly (100 cache / 1000 total)", () => {
    expect(formatCacheHitRate(100, 900)).toBe("10.0%");
  });

  test("computes 42.0% correctly (spec example)", () => {
    expect(formatCacheHitRate(420, 580)).toBe("42.0%");
  });

  test("computes 33.3% correctly (rounding 1/3)", () => {
    expect(formatCacheHitRate(1, 2)).toBe("33.3%");
  });

  test("computes 100.0% when all tokens are cache hits", () => {
    expect(formatCacheHitRate(100, 0)).toBe("100.0%");
  });

  test("computes 0.0% when no cache reads with non-zero input", () => {
    expect(formatCacheHitRate(0, 500)).toBe("0.0%");
  });
});
