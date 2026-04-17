import { describe, expect, test } from "bun:test";
import { formatLeaks, scanDotenv } from "../src/env-leak.ts";

describe("scanDotenv", () => {
  test("empty content → no leaks", () => {
    expect(scanDotenv("")).toEqual([]);
  });

  test("comments + blanks → no leaks", () => {
    const src = `
# this is a comment
  # indented comment too

`;
    expect(scanDotenv(src)).toEqual([]);
  });

  test("OPENAI_API_KEY with non-empty value → leak", () => {
    const src = "OPENAI_API_KEY=sk-abc123";
    const leaks = scanDotenv(src);
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.name).toBe("OPENAI_API_KEY");
    expect(leaks[0]!.preview).toContain("sk-a");
  });

  test("placeholder values are skipped", () => {
    const src = `
OPENAI_API_KEY=<changeme>
ANTHROPIC_API_KEY=""
GEMINI_API_KEY=xxx
`;
    expect(scanDotenv(src)).toEqual([]);
  });

  test("quoted values are stripped before length check", () => {
    const leaks = scanDotenv(`SECRET_TOKEN="abcd"`);
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.preview).toContain("4 chars");
  });

  test("non-secret names ignored", () => {
    const leaks = scanDotenv(`NODE_ENV=production\nPORT=3000`);
    expect(leaks).toEqual([]);
  });

  test("multi-line picks correct line numbers", () => {
    const src = `
NODE_ENV=prod
OPENAI_API_KEY=sk-1
ANOTHER=ok
ANTHROPIC_API_KEY=sk-2
`;
    const leaks = scanDotenv(src);
    expect(leaks.map((l) => [l.line, l.name])).toEqual([
      [3, "OPENAI_API_KEY"],
      [5, "ANTHROPIC_API_KEY"],
    ]);
  });
});

describe("formatLeaks", () => {
  test("empty list → empty string", () => {
    expect(formatLeaks([])).toBe("");
  });

  test("single leak plural", () => {
    const out = formatLeaks([{ line: 1, name: "SECRET_KEY", preview: "abcd…(4 chars)" }]);
    expect(out).toContain("1 secret-looking entry");
    expect(out).toContain("--allow-env-keys");
  });

  test("multiple leaks pluralise", () => {
    const out = formatLeaks([
      { line: 1, name: "A_KEY", preview: "x" },
      { line: 2, name: "B_KEY", preview: "y" },
    ]);
    expect(out).toContain("2 secret-looking entries");
  });
});
