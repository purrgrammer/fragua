// Duration parser tests. Property-heavy because the function has a
// small input alphabet and a clean mathematical contract — ideal for
// fast-check to sweep the boundary conditions.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { InvalidDurationError, parseDurationMs } from "../src/duration.ts";

describe("parseDurationMs — examples", () => {
  test("bare integer passes through", () => {
    expect(parseDurationMs(1)).toBe(1);
    expect(parseDurationMs(250)).toBe(250);
    expect(parseDurationMs(1_000_000)).toBe(1_000_000);
  });

  test("ms unit", () => {
    expect(parseDurationMs("1ms")).toBe(1);
    expect(parseDurationMs("500ms")).toBe(500);
    expect(parseDurationMs("0500ms")).toBe(500); // leading zeros tolerated by parseInt
  });

  test("s unit", () => {
    expect(parseDurationMs("1s")).toBe(1_000);
    expect(parseDurationMs("30s")).toBe(30_000);
  });

  test("m unit", () => {
    expect(parseDurationMs("1m")).toBe(60_000);
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("30m")).toBe(1_800_000);
  });

  test("h unit", () => {
    expect(parseDurationMs("1h")).toBe(3_600_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
  });

  test("whitespace is trimmed", () => {
    expect(parseDurationMs("  5m ")).toBe(300_000);
  });

  test("digits without unit default to ms", () => {
    expect(parseDurationMs("500")).toBe(500);
  });
});

describe("parseDurationMs — rejects", () => {
  test.each([
    ["", "empty"],
    ["   ", "whitespace"],
    ["0", "zero"],
    ["0ms", "zero ms"],
    ["0s", "zero s"],
    ["-5s", "negative"],
    ["5x", "unknown unit"],
    ["5 s", "internal space"],
    ["5.5s", "fractional"],
    ["5ms5s", "double unit"],
    ["abc", "non-numeric"],
    ["ms", "unit only"],
    ["5secs", "long unit"],
    ["NaN", "NaN string"],
    ["Infinity", "Infinity string"],
    ["1e3", "scientific notation"],
    ["+5s", "leading plus"],
  ])("rejects %p (%s)", (input) => {
    expect(() => parseDurationMs(input)).toThrow(InvalidDurationError);
  });

  test.each([
    [0, "zero int"],
    [-1, "negative int"],
    [0.5, "fractional"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "+Inf"],
    [Number.NEGATIVE_INFINITY, "-Inf"],
  ])("rejects number %p (%s)", (input) => {
    expect(() => parseDurationMs(input)).toThrow(InvalidDurationError);
  });

  test("rejects non-string non-number", () => {
    expect(() => parseDurationMs(null as unknown as string)).toThrow(InvalidDurationError);
    expect(() => parseDurationMs(undefined as unknown as string)).toThrow(InvalidDurationError);
    expect(() => parseDurationMs({} as unknown as string)).toThrow(InvalidDurationError);
    expect(() => parseDurationMs([] as unknown as string)).toThrow(InvalidDurationError);
  });
});

describe("parseDurationMs — properties", () => {
  test("positive integers round-trip as bare numbers", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000 }), (n) => {
        expect(parseDurationMs(n)).toBe(n);
      }),
    );
  });

  test("digits-only strings equal their parsed int (ms default)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000 }), (n) => {
        expect(parseDurationMs(String(n))).toBe(n);
      }),
    );
  });

  const unitProp = (unit: "ms" | "s" | "m" | "h", multiplier: number, maxN: number) => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: maxN }), (n) => {
        expect(parseDurationMs(`${n}${unit}`)).toBe(n * multiplier);
      }),
    );
  };

  test("ms multiplier", () => unitProp("ms", 1, 1_000_000_000));
  test("s  multiplier", () => unitProp("s", 1_000, 1_000_000));
  test("m  multiplier", () => unitProp("m", 60_000, 10_000));
  test("h  multiplier", () => unitProp("h", 3_600_000, 1_000));

  test("s and m encodings are equivalent where they overlap", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000 }), (minutes) => {
        expect(parseDurationMs(`${minutes}m`)).toBe(parseDurationMs(`${minutes * 60}s`));
      }),
    );
  });

  test("m and h encodings are equivalent where they overlap", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (hours) => {
        expect(parseDurationMs(`${hours}h`)).toBe(parseDurationMs(`${hours * 60}m`));
      }),
    );
  });

  test("result is always a positive safe integer (success path)", () => {
    const validInput = fc.oneof(
      fc.integer({ min: 1, max: 1_000_000 }),
      fc
        .tuple(fc.integer({ min: 1, max: 1_000_000 }), fc.constantFrom("ms", "s", "m", "h"))
        .map(([n, u]) => `${n}${u}`),
    );
    fc.assert(
      fc.property(validInput, (input) => {
        const out = parseDurationMs(input);
        expect(Number.isSafeInteger(out)).toBe(true);
        expect(out).toBeGreaterThan(0);
      }),
    );
  });

  test("bad input throws rather than returning garbage", () => {
    // Any string that doesn't match the grammar must throw. We seed with
    // a mix of arbitrary strings and constructed near-misses.
    const nearMiss = fc.oneof(
      fc.string({ maxLength: 10 }).filter((s) => !/^\s*\d+(ms|s|m|h)?\s*$/.test(s) && s.length > 0),
      fc.constantFrom("5x", "5ms5", "ms5", "  ", "", "0", "0s", "-1", "1.5s", "1e3"),
    );
    fc.assert(
      fc.property(nearMiss, (input) => {
        expect(() => parseDurationMs(input)).toThrow(InvalidDurationError);
      }),
    );
  });
});
