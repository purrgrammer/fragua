import { describe, expect, test } from "bun:test";
import { CONTEXT_FILES_MAX_BYTES, loadContextFiles, mergeSystemPrompt } from "../src/system-prompt.ts";

function stubEnv(files: Record<string, string>): { readFile(path: string): Promise<string> } {
  return {
    readFile: async (path: string) => {
      if (path in files) return files[path]!;
      throw new Error(`ENOENT: ${path}`);
    },
  };
}

describe("loadContextFiles", () => {
  test("empty paths list → empty block, no warnings", async () => {
    const res = await loadContextFiles(stubEnv({}), []);
    expect(res.text).toBe("");
    expect(res.warnings).toEqual([]);
  });

  test("loads files into labelled project-conventions blocks", async () => {
    const env = stubEnv({
      "AGENTS.md": "pure core rule",
      "docs/SPEC.md": "spec body",
    });
    const res = await loadContextFiles(env, ["AGENTS.md", "docs/SPEC.md"]);
    expect(res.warnings).toEqual([]);
    expect(res.text).toContain(`<project-conventions source="AGENTS.md">`);
    expect(res.text).toContain("pure core rule");
    expect(res.text).toContain(`<project-conventions source="docs/SPEC.md">`);
    expect(res.text).toContain("spec body");
  });

  test("missing file warns and skips, other files still load", async () => {
    const env = stubEnv({ "AGENTS.md": "ok" });
    const res = await loadContextFiles(env, ["AGENTS.md", "MISSING.md"]);
    expect(res.text).toContain("ok");
    expect(res.text).not.toContain("MISSING.md</project-conventions>");
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("MISSING.md");
  });

  test("all files missing → empty text + warnings", async () => {
    const res = await loadContextFiles(stubEnv({}), ["a.md", "b.md"]);
    expect(res.text).toBe("");
    expect(res.warnings).toHaveLength(2);
  });

  test("truncates when over max_bytes cap", async () => {
    const big = "x".repeat(100);
    const env = stubEnv({ "big.md": big });
    const res = await loadContextFiles(env, ["big.md"], 32);
    expect(res.text.length).toBeLessThanOrEqual(32 + 200); // 32 + the truncation marker
    expect(res.warnings.some((w) => w.includes("truncated"))).toBe(true);
  });

  test("default cap is 32 KiB", () => {
    expect(CONTEXT_FILES_MAX_BYTES).toBe(32 * 1024);
  });
});

describe("mergeSystemPrompt", () => {
  test("no extension → returns base", () => {
    expect(mergeSystemPrompt("base", "")).toBe("base");
  });

  test("no base → returns extension", () => {
    expect(mergeSystemPrompt("", "ext")).toBe("ext");
  });

  test("extension goes first, separated by blank line", () => {
    expect(mergeSystemPrompt("base", "ext")).toBe("ext\n\nbase");
  });
});
