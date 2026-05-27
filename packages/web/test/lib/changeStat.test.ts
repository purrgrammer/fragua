import { describe, expect, test } from "vitest";
import { summarizeChangeStat } from "../../src/lib/changeStat.ts";

describe("summarizeChangeStat", () => {
  const committed = { filesChanged: 3, insertions: 12, deletions: 2 };
  const uncommitted = { filesChanged: 1, insertions: 4, deletions: 0 };

  test("prefers committed over uncommitted when both are present", () => {
    const result = summarizeChangeStat({ committed, uncommitted });
    expect(result).toEqual(committed);
  });

  test("falls back to uncommitted when committed is null", () => {
    const result = summarizeChangeStat({ committed: null, uncommitted });
    expect(result).toEqual(uncommitted);
  });

  test("returns null when committed is null and uncommitted is null", () => {
    const result = summarizeChangeStat({ committed: null, uncommitted: null });
    expect(result).toBeNull();
  });

  test("returns null when changeStat is undefined", () => {
    const result = summarizeChangeStat(undefined);
    expect(result).toBeNull();
  });

  test("returns committed when uncommitted is null", () => {
    const result = summarizeChangeStat({ committed, uncommitted: null });
    expect(result).toEqual(committed);
  });
});
