import { describe, expect, test } from "vitest";
import { formatCacheHitRate } from "./format.ts";

describe("formatCacheHitRate", () => {
  // ── zero-denominator cases ──────────────────────────────────────

  test("returns — when all inputs are 0", () => {
    expect(formatCacheHitRate(0, 0, 0)).toBe("—");
    // Default cacheWrite=0 path.
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

  test("returns — when cacheWriteTokens is null", () => {
    expect(formatCacheHitRate(100, 100, null)).toBe("—");
  });

  test("returns — when cacheWriteTokens is NaN", () => {
    expect(formatCacheHitRate(100, 100, Number.NaN)).toBe("—");
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

  // ── new three-argument formula ──────────────────────────────────

  test("includes cacheWriteTokens in the denominator (the bug fix)", () => {
    // Pre-fix would have been 100 / (100 + 0) = 100% — misleadingly high.
    // Post-fix: 100 / (100 + 0 + 200) = 33.3% — accurately reflects that
    // we paid cache-write rates on 200 tokens that we only read 100 of.
    expect(formatCacheHitRate(100, 0, 200)).toBe("33.3%");
  });

  test("3-arg with realistic warm-thread shape (the failure case)", () => {
    // Snapshot from a real llm turn: cacheRead 164847, input 6,
    // cacheWrite 83035. Pre-fix denom = 164853 → 99.99% → "100.0%"
    // displayed. Post-fix denom = 247888 → ~66.5%.
    const r = formatCacheHitRate(164847, 6, 83035);
    expect(r).toBe("66.5%");
  });

  // ── formatting (whole vs. fractional) ───────────────────────────

  test("renders whole percentages without a trailing .0", () => {
    // 100 / (100 + 0 + 0) = 100% → "100%", not "100.0%"
    expect(formatCacheHitRate(100, 0, 0)).toBe("100%");
    // 0 / (0 + 500 + 0) = 0% → "0%", not "0.0%"
    expect(formatCacheHitRate(0, 500, 0)).toBe("0%");
  });

  test("renders fractional percentages with one decimal", () => {
    // 1 / (2 + 1 + 0) = 0.333… → "33.3%"
    expect(formatCacheHitRate(1, 2, 0)).toBe("33.3%");
  });

  test("rounds to one decimal place", () => {
    // 100 / 900 = 11.111…% → "11.1%"
    expect(formatCacheHitRate(100, 800, 0)).toBe("11.1%");
  });
});
