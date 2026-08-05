import { describe, expect, test } from "bun:test";
import {
  applyDefaultContextFiles,
  buildSystemPrompt,
  CONTEXT_FILES_MAX_BYTES,
  loadContextFiles,
  mergeSystemPrompt,
  renderRunEnvironment,
} from "../src/system-prompt.ts";

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

  describe("AGENTS.md → CLAUDE.md fallback", () => {
    test("AGENTS.md missing + CLAUDE.md present → loads CLAUDE.md, no warning", async () => {
      const env = stubEnv({ "CLAUDE.md": "claude rules" });
      const res = await loadContextFiles(env, ["AGENTS.md"]);
      expect(res.warnings).toEqual([]);
      expect(res.text).toContain(`<project-conventions source="CLAUDE.md">`);
      expect(res.text).toContain("claude rules");
      expect(res.files).toHaveLength(1);
      expect(res.files[0]).toMatchObject({ path: "CLAUDE.md", status: "ok" });
    });

    test("AGENTS.md present → loads it (no fallback probe, no double-load)", async () => {
      const env = stubEnv({ "AGENTS.md": "agents rules", "CLAUDE.md": "claude rules" });
      const res = await loadContextFiles(env, ["AGENTS.md"]);
      expect(res.warnings).toEqual([]);
      expect(res.text).toContain(`<project-conventions source="AGENTS.md">`);
      expect(res.text).toContain("agents rules");
      expect(res.text).not.toContain("claude rules");
      expect(res.files).toHaveLength(1);
      expect(res.files[0]).toMatchObject({ path: "AGENTS.md", status: "ok" });
    });

    test("AGENTS.md missing + CLAUDE.md missing → original AGENTS.md warning", async () => {
      const res = await loadContextFiles(stubEnv({}), ["AGENTS.md"]);
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0]).toContain("AGENTS.md");
      // The warning quotes the requested path (AGENTS.md), not the fallback —
      // the user asked for AGENTS.md; CLAUDE.md is an internal recovery attempt.
      expect(res.warnings[0]).not.toContain("CLAUDE.md");
      expect(res.files).toHaveLength(1);
      expect(res.files[0]).toMatchObject({ path: "AGENTS.md", status: "missing" });
    });

    test("explicit list includes CLAUDE.md → no fallback (CLAUDE.md loads on its own iteration)", async () => {
      // Author asked for both. AGENTS.md is missing → recorded missing (not
      // shadowed by the fallback). CLAUDE.md loads normally on its own turn.
      const env = stubEnv({ "CLAUDE.md": "claude rules" });
      const res = await loadContextFiles(env, ["AGENTS.md", "CLAUDE.md"]);
      expect(res.files).toHaveLength(2);
      expect(res.files[0]).toMatchObject({ path: "AGENTS.md", status: "missing" });
      expect(res.files[1]).toMatchObject({ path: "CLAUDE.md", status: "ok" });
      // CLAUDE.md content appears exactly once — no double-load.
      const matches = res.text.match(/claude rules/g) ?? [];
      expect(matches).toHaveLength(1);
    });
  });
});

describe("applyDefaultContextFiles", () => {
  test("empty declared list → AGENTS.md only", () => {
    expect(applyDefaultContextFiles([])).toEqual(["AGENTS.md"]);
  });

  test("AGENTS.md prepended ahead of other files", () => {
    expect(applyDefaultContextFiles(["docs/SPEC.md", "docs/handler-contract.md"])).toEqual([
      "AGENTS.md",
      "docs/SPEC.md",
      "docs/handler-contract.md",
    ]);
  });

  test("explicit AGENTS.md is preserved without duplication", () => {
    expect(applyDefaultContextFiles(["AGENTS.md"])).toEqual(["AGENTS.md"]);
  });

  test("explicit AGENTS.md anywhere in the list keeps the author's order", () => {
    expect(applyDefaultContextFiles(["docs/SPEC.md", "AGENTS.md"])).toEqual(["docs/SPEC.md", "AGENTS.md"]);
  });

  test("returns a fresh array — does not alias the input", () => {
    const declared = ["AGENTS.md"];
    const out = applyDefaultContextFiles(declared);
    expect(out).not.toBe(declared);
    expect(out).toEqual(declared);
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

describe("renderRunEnvironment", () => {
  test("with bootstrap command", () => {
    const block = renderRunEnvironment({
      bootstrapCommand: "bun install --frozen-lockfile",
    });
    expect(block).toContain("<environment>");
    expect(block).toContain("Work inside the working directory");
    expect(block).toContain("refuses `cd` out of it");
    expect(block).toContain("`bun install --frozen-lockfile` ran here");
    expect(block).toContain("</environment>");
  });

  test("without bootstrap, omits the bootstrap line", () => {
    const block = renderRunEnvironment({});
    expect(block).toContain("Work inside the working directory");
    expect(block).not.toContain("ran here");
  });

  test("no `worktree:` label — terminology stays env-agnostic", () => {
    expect(renderRunEnvironment({})).not.toContain("worktree:");
  });

  // The block is a prompt-cache prefix. A run id or an absolute worktree
  // path in here makes the system prompt unique per run, which invalidates
  // the whole tools+system cache segment on every run. These two assertions
  // are the guard — they are the entire point of the block's shape.
  test("never emits a run id or an absolute path", () => {
    const block = renderRunEnvironment({ bootstrapCommand: "bun install" });
    expect(block).not.toContain("run_id");
    expect(block).not.toContain("cwd:");
    // No absolute path anywhere: nothing in the block should start a
    // path-looking token with `/`, and `.fragua/worktrees/<run-id>` in
    // particular must never appear.
    expect(block).not.toContain(".fragua/worktrees");
    expect(block).not.toMatch(/\s\/[A-Za-z]/);
  });
});

describe("buildSystemPrompt with runEnv", () => {
  test("prepends <environment> before every other block", () => {
    const out = buildSystemPrompt({
      global: "you are the agent",
      perNode: undefined,
      contextBlock: "<project-conventions>rules</project-conventions>",
      runEnv: {},
    });
    const envIdx = out.indexOf("<environment>");
    const conventionsIdx = out.indexOf("<project-conventions>");
    const baseIdx = out.indexOf("you are the agent");
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(envIdx).toBeLessThan(conventionsIdx);
    expect(conventionsIdx).toBeLessThan(baseIdx);
  });

  test("omits <environment> entirely when runEnv is undefined", () => {
    const out = buildSystemPrompt({
      global: "base",
      perNode: undefined,
      contextBlock: "",
    });
    expect(out).not.toContain("<environment>");
    expect(out.endsWith("base")).toBe(true);
  });

  test("whole system prompt is byte-identical across two runs of the same node", () => {
    const build = () =>
      buildSystemPrompt({
        global: "you are the agent",
        perNode: undefined,
        contextBlock: "<project-conventions>rules</project-conventions>",
        skillsCatalog: "<available_skills></available_skills>",
        runEnv: { bootstrapCommand: "bun install" },
      });
    expect(build()).toBe(build());
  });
});
