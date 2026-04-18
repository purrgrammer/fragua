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
  test("empty paths list → empty block, no warnings, no file records", async () => {
    const res = await loadContextFiles(stubEnv({}), []);
    expect(res.text).toBe("");
    expect(res.warnings).toEqual([]);
    expect(res.files).toEqual([]);
  });

  test("loads files into labelled project-conventions blocks with per-file records", async () => {
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
    expect(res.files).toHaveLength(2);
    expect(res.files[0]).toMatchObject({
      path: "AGENTS.md",
      status: "ok",
      truncated: false,
      bytes: Buffer.byteLength("pure core rule", "utf8"),
    });
    expect(res.files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.files[1]!.path).toBe("docs/SPEC.md");
    // Different contents → different sha.
    expect(res.files[0]!.sha256).not.toBe(res.files[1]!.sha256);
  });

  test("missing file warns but keeps a file record with status=missing", async () => {
    const env = stubEnv({ "AGENTS.md": "ok" });
    const res = await loadContextFiles(env, ["AGENTS.md", "MISSING.md"]);
    expect(res.text).toContain("ok");
    expect(res.text).not.toContain("MISSING.md</project-conventions>");
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("MISSING.md");
    expect(res.files).toHaveLength(2);
    expect(res.files[0]).toMatchObject({ path: "AGENTS.md", status: "ok" });
    expect(res.files[1]).toMatchObject({ path: "MISSING.md", status: "missing", bytes: 0, sha256: "" });
    expect(res.files[1]!.error).toContain("MISSING.md");
  });

  test("all files missing → empty text + warnings + missing records", async () => {
    const res = await loadContextFiles(stubEnv({}), ["a.md", "b.md"]);
    expect(res.text).toBe("");
    expect(res.warnings).toHaveLength(2);
    expect(res.files.map((f) => f.status)).toEqual(["missing", "missing"]);
  });

  test("truncates when over max_bytes cap and flags every loaded file", async () => {
    const big = "x".repeat(100);
    const env = stubEnv({ "big.md": big });
    const res = await loadContextFiles(env, ["big.md"], 32);
    expect(res.text.length).toBeLessThanOrEqual(32 + 200); // 32 + the truncation marker
    expect(res.warnings.some((w) => w.includes("truncated"))).toBe(true);
    expect(res.files).toHaveLength(1);
    expect(res.files[0]!.truncated).toBe(true);
    // Raw byte count is pre-truncation — the whole source file.
    expect(res.files[0]!.bytes).toBe(100);
  });

  test("sha256 is deterministic across runs for the same contents", async () => {
    const env = stubEnv({ "a.md": "same" });
    const a = await loadContextFiles(env, ["a.md"]);
    const b = await loadContextFiles(env, ["a.md"]);
    expect(a.files[0]!.sha256).toBe(b.files[0]!.sha256);
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
