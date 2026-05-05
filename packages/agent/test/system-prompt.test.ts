import { describe, expect, test } from "bun:test";
import type { Skill } from "@swarm/types";
import {
  applyDefaultContextFiles,
  buildSystemPrompt,
  CONTEXT_FILES_MAX_BYTES,
  loadContextFiles,
  materialiseForChild,
  mergeSystemPrompt,
  renderProtocol,
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
      worktreePath: "/wt/abc",
      runId: "abc",
      bootstrapCommand: "bun install --frozen-lockfile",
    });
    expect(block).toContain("<environment>");
    expect(block).toContain("cwd: /wt/abc");
    expect(block).toContain("Bash starts in cwd");
    // ❌ antipattern interpolates the actual cwd — by reflecting the value
    // the model is tempted to echo, the example breaks the cargo-culted
    // `cd <cwd> && cmd` habit.
    expect(block).toContain("❌ cd /wt/abc && pwd");
    expect(block).toContain("✅ pwd");
    expect(block).toContain("File tools resolve paths relative to cwd");
    expect(block).toContain("✅ README.md");
    expect(block).toContain("❌ /wt/abc/README.md");
    expect(block).toContain("`bun install --frozen-lockfile` ran here");
    expect(block).toContain("</environment>");
  });

  test("without bootstrap, omits the bootstrap line", () => {
    const block = renderRunEnvironment({
      worktreePath: "/wt/x",
      runId: "x",
    });
    expect(block).toContain("cwd: /wt/x");
    expect(block).toContain("Bash starts in cwd");
    expect(block).not.toContain("ran here");
  });

  test("does not surface run_id (unused by agent, costs tokens)", () => {
    const block = renderRunEnvironment({
      worktreePath: "/wt/x",
      runId: "01jx-this-id-should-not-leak",
    });
    expect(block).not.toContain("01jx-this-id-should-not-leak");
    expect(block).not.toContain("run_id");
  });

  test("no `worktree:` label — terminology stays env-agnostic", () => {
    const block = renderRunEnvironment({
      worktreePath: "/some/path",
      runId: "x",
    });
    expect(block).not.toContain("worktree:");
  });
});

describe("renderProtocol", () => {
  test("teaches the <abort> own-line contract", () => {
    const block = renderProtocol();
    expect(block).toContain("<protocol>");
    expect(block).toContain("</protocol>");
    expect(block).toContain("<abort>reason</abort>");
    expect(block).toContain("entire last non-empty line");
  });

  test("is a constant — same bytes on every call (cache-key invariant)", () => {
    expect(renderProtocol()).toBe(renderProtocol());
  });
});

describe("buildSystemPrompt with runEnv", () => {
  test("prepends <environment> then <protocol> before every other block", () => {
    const out = buildSystemPrompt({
      global: "you are the agent",
      perNode: undefined,
      contextBlock: "<project-conventions>rules</project-conventions>",
      runEnv: { worktreePath: "/wt/abc", runId: "abc" },
    });
    const envIdx = out.indexOf("<environment>");
    const protocolIdx = out.indexOf("<protocol>");
    const conventionsIdx = out.indexOf("<project-conventions>");
    const baseIdx = out.indexOf("you are the agent");
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(protocolIdx).toBeGreaterThan(envIdx);
    expect(protocolIdx).toBeLessThan(conventionsIdx);
    expect(conventionsIdx).toBeLessThan(baseIdx);
  });

  test("omits <environment> entirely when runEnv is undefined, but always includes <protocol>", () => {
    const out = buildSystemPrompt({
      global: "base",
      perNode: undefined,
      contextBlock: "",
    });
    expect(out).not.toContain("<environment>");
    expect(out).toContain("<protocol>");
    expect(out).toContain("<abort>reason</abort>");
    expect(out.endsWith("base")).toBe(true);
  });
});

function makeSkill(name: string): Skill {
  return {
    name,
    description: `${name} skill description`,
    location: `/skills/${name}/SKILL.md`,
    skill_dir: `/skills/${name}`,
    sha256: "deadbeef",
    bytes: 100,
    scope: "user",
    source_dir: `/skills/${name}`,
  };
}

describe("materialiseForChild", () => {
  const parentSystemPrompt = "PARENT BASE PERSONA\n<protocol>\n…\n</protocol>";
  const parentSkills: Skill[] = [makeSkill("a"), makeSkill("b"), makeSkill("c")];

  test("returns empty per-node prompt when spec.system_prompt is undefined (backend builds fresh minimal prompt)", () => {
    // Earlier behaviour was to inherit the parent's *fully-assembled*
    // prompt (10s of KB of tools/skills/context-files for a pool the
    // sub-agent doesn't even have). We now return empty so the
    // codergen backend builds a fresh minimal prompt for the child's
    // own pool — global framework persona stays automatic.
    const out = materialiseForChild({}, parentSystemPrompt, parentSkills);
    expect(out.systemPrompt).toBe("");
    expect(out.effectiveSkills).toEqual([]);
  });

  test("replaces persona when spec.system_prompt is set; protocol block is reapplied", () => {
    const out = materialiseForChild({ system_prompt: "REVIEWER" }, parentSystemPrompt, parentSkills);
    expect(out.systemPrompt).toContain("REVIEWER");
    expect(out.systemPrompt).not.toContain("PARENT BASE PERSONA");
    expect(out.systemPrompt).toContain("<protocol>");
    expect(out.systemPrompt).toContain("<abort>reason</abort>");
  });

  test("filters skills to spec.skills set; empty / unset spec.skills means no skills", () => {
    const filtered = materialiseForChild({ skills: ["b"] }, parentSystemPrompt, parentSkills);
    expect(filtered.effectiveSkills.map((s) => s.name)).toEqual(["b"]);

    const noSkills = materialiseForChild({}, parentSystemPrompt, parentSkills);
    expect(noSkills.effectiveSkills).toEqual([]);
  });

  test("unknown skill names are silently dropped", () => {
    const out = materialiseForChild({ skills: ["a", "does-not-exist"] }, parentSystemPrompt, parentSkills);
    expect(out.effectiveSkills.map((s) => s.name)).toEqual(["a"]);
  });

  test("override + skills renders a skills catalog block alongside the protocol and the override persona", () => {
    const out = materialiseForChild({ system_prompt: "REVIEWER", skills: ["a"] }, parentSystemPrompt, parentSkills);
    expect(out.systemPrompt).toContain("REVIEWER");
    expect(out.systemPrompt).toContain("<available_skills>");
    expect(out.systemPrompt).toContain("a skill description");
    expect(out.systemPrompt).toContain("<protocol>");
    // Protocol sits above the skills catalog (top-down: protocol →
    // skills → persona) — matches `buildSystemPrompt` layering.
    const protocolIdx = out.systemPrompt.indexOf("<protocol>");
    const skillsIdx = out.systemPrompt.indexOf("<available_skills>");
    const personaIdx = out.systemPrompt.indexOf("REVIEWER");
    expect(protocolIdx).toBeGreaterThanOrEqual(0);
    expect(skillsIdx).toBeGreaterThan(protocolIdx);
    expect(personaIdx).toBeGreaterThan(skillsIdx);
  });
});
