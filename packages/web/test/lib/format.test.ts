// Tests for the number/currency formatters. Locale pinned to en-US so
// assertions stay deterministic across ICU versions / host locales.

import { describe, expect, it } from "vitest";
import { formatTokensCompact, formatTokensLong, formatUsd } from "../../src/lib/format.ts";

const L = { locale: "en-US" } as const;

describe("formatUsd", () => {
  it("renders dollar costs with 2 fraction digits", () => {
    expect(formatUsd(1.23, L)).toBe("$1.23");
    expect(formatUsd(12.3, L)).toBe("$12.30");
  });

  it("renders sub-dollar costs with 3 fraction digits", () => {
    expect(formatUsd(0.123, L)).toBe("$0.123");
  });

  it("renders sub-cent costs with 4 fraction digits so they don't collapse to $0.00", () => {
    expect(formatUsd(0.0007, L)).toBe("$0.0007");
  });

  it("zero renders as $0.00 (two fraction digits, canonical)", () => {
    expect(formatUsd(0, L)).toBe("$0.00");
  });

  it("falls back on null / NaN / negative / undefined", () => {
    expect(formatUsd(null, L)).toBe("—");
    expect(formatUsd(undefined, L)).toBe("—");
    expect(formatUsd(Number.NaN, L)).toBe("—");
    expect(formatUsd(-1, L)).toBe("—");
  });

  it("honours a custom fallback", () => {
    expect(formatUsd(null, { ...L, fallback: "(n/a)" })).toBe("(n/a)");
  });
});

describe("formatTokensCompact", () => {
  it("renders <1000 as plain integers", () => {
    expect(formatTokensCompact(0, L)).toBe("0");
    expect(formatTokensCompact(42, L)).toBe("42");
    expect(formatTokensCompact(999, L)).toBe("999");
  });

  it("switches to compact notation at ≥1000", () => {
    // Intl en-US renders these as "1K", "4.2K", "1M" etc.
    expect(formatTokensCompact(1000, L)).toBe("1K");
    expect(formatTokensCompact(4200, L)).toBe("4.2K");
    expect(formatTokensCompact(1_000_000, L)).toBe("1M");
  });

  it("falls back for invalid inputs", () => {
    expect(formatTokensCompact(null, L)).toBe("—");
    expect(formatTokensCompact(Number.NaN, L)).toBe("—");
    expect(formatTokensCompact(-5, L)).toBe("—");
  });
});

describe("formatTokensLong", () => {
  it("renders with thousand separators", () => {
    expect(formatTokensLong(1234, L)).toBe("1,234");
    expect(formatTokensLong(1_234_567, L)).toBe("1,234,567");
  });

  it("falls back for invalid inputs", () => {
    expect(formatTokensLong(null, L)).toBe("—");
    expect(formatTokensLong(undefined, L)).toBe("—");
  });
});
