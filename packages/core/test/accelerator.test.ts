import { describe, expect, test } from "bun:test";
import { parseAcceleratorKey, stripAcceleratorPrefix } from "../src/accelerator.ts";

describe("parseAcceleratorKey", () => {
  test("[K] bracketed pattern", () => {
    expect(parseAcceleratorKey("[A] Approve")).toBe("A");
    expect(parseAcceleratorKey("[1] Pick one")).toBe("1");
  });

  test("K) paren pattern", () => {
    expect(parseAcceleratorKey("R) Revise")).toBe("R");
    expect(parseAcceleratorKey("3) Third option")).toBe("3");
  });

  test("K - hyphen pattern", () => {
    expect(parseAcceleratorKey("Y - Yes")).toBe("Y");
    expect(parseAcceleratorKey("N - No")).toBe("N");
  });

  test("falls back to first character when no annotation", () => {
    expect(parseAcceleratorKey("Approve")).toBe("A");
    expect(parseAcceleratorKey("revise")).toBe("R");
  });

  test("normalises to upper case", () => {
    expect(parseAcceleratorKey("[a] approve")).toBe("A");
    expect(parseAcceleratorKey("y - yes")).toBe("Y");
    expect(parseAcceleratorKey("approve")).toBe("A");
  });

  test("empty label → '?' sentinel", () => {
    expect(parseAcceleratorKey("")).toBe("?");
  });

  test("non-alphanumeric leading chars don't match the annotation patterns", () => {
    // "?" isn't in [A-Za-z0-9], so the bracketed pattern misses and we fall
    // through to first-char (which IS the bracket itself).
    expect(parseAcceleratorKey("[?] What?")).toBe("[");
    // Hyphen with non-alnum letter falls through similarly.
    expect(parseAcceleratorKey("- skip")).toBe("-");
  });

  test("hyphen pattern requires exactly ' - ' (space-dash-space)", () => {
    // No spaces around dash → falls through to first char.
    expect(parseAcceleratorKey("A-Yes")).toBe("A");
    // Only trailing space → falls through.
    expect(parseAcceleratorKey("A -Yes")).toBe("A");
  });
});

describe("stripAcceleratorPrefix", () => {
  test("strips [K] bracketed annotations", () => {
    expect(stripAcceleratorPrefix("[A] Approve")).toBe("Approve");
    expect(stripAcceleratorPrefix("[1] First option")).toBe("First option");
  });

  test("strips K) paren annotations", () => {
    expect(stripAcceleratorPrefix("R) Revise")).toBe("Revise");
    expect(stripAcceleratorPrefix("3) Third")).toBe("Third");
  });

  test("strips K - hyphenated annotations", () => {
    expect(stripAcceleratorPrefix("Y - Yes")).toBe("Yes");
    expect(stripAcceleratorPrefix("N - No")).toBe("No");
  });

  test("idempotent on already-clean labels", () => {
    expect(stripAcceleratorPrefix("Approve")).toBe("Approve");
    expect(stripAcceleratorPrefix("Just text")).toBe("Just text");
  });

  test("only strips a single leading annotation", () => {
    // Two prefixes shouldn't both come off — author error, not our problem
    // to silently fix. We strip the outermost (bracket wins).
    expect(stripAcceleratorPrefix("[A] [B] Weird")).toBe("[B] Weird");
  });

  test("returns empty string for an empty label", () => {
    expect(stripAcceleratorPrefix("")).toBe("");
  });

  test("preserves trailing content verbatim", () => {
    expect(stripAcceleratorPrefix("[A]   spaced  ")).toBe("spaced  ");
    expect(stripAcceleratorPrefix("[A] line1\nline2")).toBe("line1\nline2");
  });
});

describe("parse + strip round-trip", () => {
  // Both functions share the same regexes — when one matches, the other
  // should too. Regression guard against drift.
  test.each([
    ["[A] Approve", "A", "Approve"],
    ["R) Revise", "R", "Revise"],
    ["Y - Yes", "Y", "Yes"],
    ["plain", "P", "plain"],
    ["", "?", ""],
  ])("label=%p → key=%p, stripped=%p", (label, key, stripped) => {
    expect(parseAcceleratorKey(label)).toBe(key);
    expect(stripAcceleratorPrefix(label)).toBe(stripped);
  });
});
