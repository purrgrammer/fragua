import { describe, expect, test } from "bun:test";
import { numericQueryParam } from "../../src/store/query-params.ts";

describe("numericQueryParam", () => {
  test("returns fallback, not the negative value, for '-1' with no explicit min", () => {
    expect(numericQueryParam("-1", { fallback: 1000, max: 5000 })).toBe(1000);
  });

  test("returns fallback for any value below an explicit min", () => {
    expect(numericQueryParam("0", { fallback: 5, min: 1 })).toBe(5);
  });

  test("returns fallback when absent or non-finite", () => {
    expect(numericQueryParam(undefined, { fallback: 7 })).toBe(7);
    expect(numericQueryParam("abc", { fallback: 7 })).toBe(7);
    expect(numericQueryParam("Infinity", { fallback: 7 })).toBe(7);
  });

  test("accepts zero under the default floor", () => {
    expect(numericQueryParam("0", { fallback: 1000 })).toBe(0);
  });

  test("still clamps to max and passes in-range values through", () => {
    expect(numericQueryParam("999999", { fallback: 1000, max: 5000 })).toBe(5000);
    expect(numericQueryParam("42", { fallback: 1000, max: 5000 })).toBe(42);
  });
});
