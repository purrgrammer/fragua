import { describe, expect, test } from "bun:test";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  fuzzyFindText,
  generateDiffString,
  normalizeForFuzzyMatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "../src/edit-diff.ts";

describe("detectLineEnding", () => {
  test("LF default", () => expect(detectLineEnding("a\nb\nc")).toBe("\n"));
  test("CRLF when dominant", () => expect(detectLineEnding("a\r\nb\r\nc")).toBe("\r\n"));
  test("mixed picks majority", () => expect(detectLineEnding("a\r\nb\nc\r\n")).toBe("\r\n"));
});

describe("normalizeToLF / restoreLineEndings", () => {
  test("round-trips CRLF", () => {
    const original = "a\r\nb\r\n";
    const normalized = normalizeToLF(original);
    expect(normalized).toBe("a\nb\n");
    const restored = restoreLineEndings(normalized, "\r\n");
    expect(restored).toBe(original);
  });
});

describe("stripBom", () => {
  test("strips BOM", () => {
    const { bom, text } = stripBom("\uFEFFhello");
    expect(bom).toBe("\uFEFF");
    expect(text).toBe("hello");
  });
  test("no BOM passthrough", () => {
    const { bom, text } = stripBom("hello");
    expect(bom).toBe("");
    expect(text).toBe("hello");
  });
});

describe("normalizeForFuzzyMatch", () => {
  test("strips trailing whitespace", () => {
    expect(normalizeForFuzzyMatch("hello   \nworld  ")).toBe("hello\nworld");
  });
  test("normalizes smart quotes", () => {
    expect(normalizeForFuzzyMatch("\u201Chello\u201D")).toBe('"hello"');
    expect(normalizeForFuzzyMatch("it\u2019s")).toBe("it's");
  });
  test("normalizes dashes", () => {
    expect(normalizeForFuzzyMatch("a\u2014b")).toBe("a-b");
  });
});

describe("fuzzyFindText", () => {
  test("exact match", () => {
    const r = fuzzyFindText("hello world", "hello");
    expect(r.found).toBe(true);
    expect(r.index).toBe(0);
    expect(r.usedFuzzyMatch).toBe(false);
  });

  test("exact match fails on duplicate", () => {
    const r = fuzzyFindText("hello hello", "hello");
    expect(r.found).toBe(false);
  });

  test("fuzzy match on smart quotes", () => {
    const r = fuzzyFindText("it\u2019s fine", "it's fine");
    expect(r.found).toBe(true);
    expect(r.usedFuzzyMatch).toBe(true);
  });

  test("not found", () => {
    const r = fuzzyFindText("hello world", "goodbye");
    expect(r.found).toBe(false);
  });
});

describe("applyEditsToNormalizedContent", () => {
  test("single edit", () => {
    const { newContent } = applyEditsToNormalizedContent("aaa\nbbb\nccc", [{ oldText: "bbb", newText: "BBB" }], "f.ts");
    expect(newContent).toBe("aaa\nBBB\nccc");
  });

  test("multiple non-overlapping edits", () => {
    const { newContent } = applyEditsToNormalizedContent(
      "aaa\nbbb\nccc",
      [
        { oldText: "aaa", newText: "AAA" },
        { oldText: "ccc", newText: "CCC" },
      ],
      "f.ts",
    );
    expect(newContent).toBe("AAA\nbbb\nCCC");
  });

  test("throws on not found", () => {
    expect(() => applyEditsToNormalizedContent("aaa", [{ oldText: "zzz", newText: "x" }], "f.ts")).toThrow("not found");
  });

  test("throws on overlapping edits", () => {
    expect(() =>
      applyEditsToNormalizedContent(
        "abcdef",
        [
          { oldText: "abcd", newText: "X" },
          { oldText: "cdef", newText: "Y" },
        ],
        "f.ts",
      ),
    ).toThrow("Overlapping");
  });
});

describe("generateDiffString", () => {
  test("produces line-numbered diff for changed lines", () => {
    const { diff, firstChangedLine } = generateDiffString("aaa\nbbb\nccc", "aaa\nBBB\nccc");
    // New format: each line carries a leading +/-/<space>, the line
    // number from its own file, then the line text.
    expect(diff).toMatch(/-\s*2 bbb/);
    expect(diff).toMatch(/\+\s*2 BBB/);
    expect(firstChangedLine).toBe(2);
  });

  test("no changes returns empty diff", () => {
    const { diff, firstChangedLine } = generateDiffString("same", "same");
    expect(diff).toBe("");
    expect(firstChangedLine).toBeUndefined();
  });
});

describe("applyEditsToNormalizedContent — new error messages", () => {
  test("not-found error references oldText", () => {
    expect(() => applyEditsToNormalizedContent("hello", [{ oldText: "goodbye", newText: "x" }], "f.ts")).toThrow(
      /oldText not found/,
    );
  });

  test("multi-edit not-found references the edit index", () => {
    expect(() =>
      applyEditsToNormalizedContent(
        "hello",
        [
          { oldText: "hello", newText: "HELLO" },
          { oldText: "missing", newText: "x" },
        ],
        "f.ts",
      ),
    ).toThrow(/edits\[1\]/);
  });

  test("duplicate match raises duplicate error", () => {
    expect(() => applyEditsToNormalizedContent("foo foo", [{ oldText: "foo", newText: "x" }], "f.ts")).toThrow(
      /Found 2 occurrences/,
    );
  });

  test("empty oldText is rejected", () => {
    expect(() => applyEditsToNormalizedContent("hi", [{ oldText: "", newText: "x" }], "f.ts")).toThrow(
      /must not be empty/,
    );
  });

  test("no-change replacement is rejected", () => {
    expect(() => applyEditsToNormalizedContent("aaa\nbbb", [{ oldText: "aaa", newText: "aaa" }], "f.ts")).toThrow(
      /No changes made/,
    );
  });
});

describe("normalizeForFuzzyMatch — extended unicode coverage", () => {
  test("NBSP and narrow NBSP collapse to space", () => {
    expect(normalizeForFuzzyMatch("a b")).toBe("a b");
    expect(normalizeForFuzzyMatch("a b")).toBe("a b");
  });
  test("ideographic space collapses to space", () => {
    expect(normalizeForFuzzyMatch("a　b")).toBe("a b");
  });
  test("U+2212 minus collapses to ASCII hyphen", () => {
    expect(normalizeForFuzzyMatch("a−b")).toBe("a-b");
  });
  test("NFKC compatibility decomposition", () => {
    // U+FB01 (LATIN SMALL LIGATURE FI) decomposes to "fi" under NFKC.
    expect(normalizeForFuzzyMatch("ﬁrst")).toBe("first");
  });
});
