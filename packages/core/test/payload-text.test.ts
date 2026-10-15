import { describe, expect, test } from "bun:test";
import { clipPayloadText, FACT_TEXT_MAX_BYTES } from "../src/payload-text.ts";

const encodedBytes = (s: string): number => new TextEncoder().encode(JSON.stringify(s)).length - 2;

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("clipPayloadText", () => {
  test("returns text under budget unchanged", () => {
    const s = "provider said: rate limited";
    expect(clipPayloadText(s)).toBe(s);
    expect(clipPayloadText("x".repeat(FACT_TEXT_MAX_BYTES))).toBe("x".repeat(FACT_TEXT_MAX_BYTES));
  });

  test("clips to maxBytes of JSON-escaped UTF-8 with a marker", () => {
    const out = clipPayloadText("é".repeat(6000), 1000);
    expect(encodedBytes(out)).toBeLessThanOrEqual(1000);
    expect(out).toMatch(/ … \[clipped \d+ bytes\]$/);
    const dropped = Number(/clipped (\d+) bytes/.exec(out)?.[1]);
    const kept = out.slice(0, out.indexOf(" … [clipped"));
    expect(new TextEncoder().encode(kept).length + dropped).toBe(12000);
  });

  test("never splits a surrogate pair", () => {
    const out = clipPayloadText("😀".repeat(2000), 777);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(encodedBytes(out)).toBeLessThanOrEqual(777);
  });

  test("control-character input still fits after escaping", () => {
    const out = clipPayloadText("\u0001".repeat(10_000), 2048);
    expect(encodedBytes(out)).toBeLessThanOrEqual(2048);
    expect(new TextEncoder().encode(JSON.stringify({ errorMessage: out })).length).toBeLessThan(4096);
  });

  test("a budget too small for the marker returns a bare prefix that fits", () => {
    const out = clipPayloadText("abcdefghij".repeat(10), 8);
    expect(out).toBe("abcdefgh");
    expect(clipPayloadText("abc", 0)).toBe("");
  });

  test("clips a 1 MB input without quadratic cost", () => {
    const big = "y".repeat(1024 * 1024);
    const start = performance.now();
    const out = clipPayloadText(big);
    expect(performance.now() - start).toBeLessThan(50);
    expect(encodedBytes(out)).toBeLessThanOrEqual(FACT_TEXT_MAX_BYTES);
  });
});
