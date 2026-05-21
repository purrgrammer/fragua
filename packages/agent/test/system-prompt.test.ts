import { describe, expect, test } from "bun:test";
import type { Skill } from "@fragua/types";
import { loadSkill } from "@fragua/workspace";
import {
  applyDefaultContextFiles,
  buildSystemPrompt,
  CONTEXT_FILES_MAX_BYTES,
  loadContextFiles,
  materialiseForChild,
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
      cwd: "/wt/abc",
      runId: "abc",
      bootstrapCommand: "bun install --frozen-lockfile",
    });
    expect(block).toContain("<environment>");
    expect(block).toContain("cwd: /wt/abc");
    expect(block).toContain("run_id: abc");
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
      cwd: "/wt/x",
      runId: "x",
    });
    expect(block).toContain("cwd: /wt/x");
    expect(block).toContain("run_id: x");
    expect(block).toContain("Bash starts in cwd");
    expect(block).not.toContain("ran here");
  });

  test("surfaces run_id alongside cwd", () => {
    const block = renderRunEnvironment({
      cwd: "/wt/x",
      runId: "01jx-this-id-should-appear",
    });
    expect(block).toContain("01jx-this-id-should-appear");
    expect(block).toContain("run_id: 01jx-this-id-should-appear");
  });

  test("no `worktree:` label — terminology stays env-agnostic", () => {
    const block = renderRunEnvironment({
      cwd: "/some/path",
      runId: "x",
    });
    expect(block).not.toContain("worktree:");
  });
});

describe("buildSystemPrompt with runEnv", () => {
  test("prepends <environment> before every other block", () => {
    const out = buildSystemPrompt({
      global: "you are the agent",
      perNode: undefined,
      contextBlock: "<project-conventions>rules</project-conventions>",
      runEnv: { cwd: "/wt/abc", runId: "abc" },
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
});

describe("buildSystemPrompt — agents catalogue", () => {
  const agentsCatalog = [
    "## Available sub-agents",
    "",
    "Spawn one of these by calling the `agent` tool with `agent: <name>`.",
    "",
    "- `reviewer` — Reviews diffs.",
  ].join("\n");

  test("agentsCatalog is appended above skills", () => {
    const skillsBlock = "<available_skills>...</available_skills>";
    const out = buildSystemPrompt({
      global: "you are the agent",
      perNode: undefined,
      contextBlock: "",
      skillsCatalog: skillsBlock,
      agentsCatalog,
    });
    const agentsIdx = out.indexOf("## Available sub-agents");
    const skillsIdx = out.indexOf("<available_skills>");
    expect(agentsIdx).toBeGreaterThan(-1);
    expect(skillsIdx).toBeGreaterThan(-1);
    expect(agentsIdx).toBeLessThan(skillsIdx);
  });

  test("agentsCatalog absent → no '## Available sub-agents' header", () => {
    const out = buildSystemPrompt({
      global: "base",
      perNode: undefined,
      contextBlock: "",
    });
    expect(out).not.toContain("## Available sub-agents");
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
  // Parent's pre-rendered framework inputs. Sub-agents consume these
  // verbatim so the child sees the same project primer + worktree
  // facts the parent saw, with the child's persona appended last.
  const parentFramework = {
    contextBlock: "<project-conventions>\nproject AGENTS.md\n</project-conventions>",
    runEnv: { cwd: "/tmp/wt", runId: "run-1" } as const,
  };
  const parentSkills: Skill[] = [makeSkill("a"), makeSkill("b"), makeSkill("c")];

  test("framework blocks render even when spec carries no persona / skills", () => {
    // Old behaviour returned "" — sub-agents ran with no project
    // conventions and no env block. New contract: env + project conv
    // always land so the child reads the same primer the parent did.
    const out = materialiseForChild({}, parentFramework, parentSkills);
    expect(out.systemPrompt).toContain("<environment>");
    expect(out.systemPrompt).toContain("project AGENTS.md");
    expect(out.effectiveSkills).toEqual([]);
  });

  test("persona is appended LAST, after framework blocks", () => {
    const out = materialiseForChild({ system_prompt: "REVIEWER" }, parentFramework, parentSkills);
    expect(out.systemPrompt).toContain("REVIEWER");
    expect(out.systemPrompt).toContain("<environment>");
    // Persona reads as the last framing the model sees before the user prompt.
    const personaIdx = out.systemPrompt.indexOf("REVIEWER");
    const envIdx = out.systemPrompt.indexOf("<environment>");
    expect(personaIdx).toBeGreaterThan(envIdx);
  });

  test("filters skills to spec.skills set; empty / unset spec.skills means no skills", () => {
    const filtered = materialiseForChild({ skills: ["b"] }, parentFramework, parentSkills);
    expect(filtered.effectiveSkills.map((s) => s.name)).toEqual(["b"]);

    const noSkills = materialiseForChild({}, parentFramework, parentSkills);
    expect(noSkills.effectiveSkills).toEqual([]);
  });

  test("unknown skill names are silently dropped", () => {
    const out = materialiseForChild({ skills: ["a", "does-not-exist"] }, parentFramework, parentSkills);
    expect(out.effectiveSkills.map((s) => s.name)).toEqual(["a"]);
  });

  test("child sees its own filtered skills catalogue, not the parent's full set", () => {
    const out = materialiseForChild({ system_prompt: "REVIEWER", skills: ["a"] }, parentFramework, parentSkills);
    expect(out.systemPrompt).toContain("REVIEWER");
    expect(out.systemPrompt).toContain("<available_skills>");
    expect(out.systemPrompt).toContain("a skill description");
    // Other parent skills are NOT exposed.
    expect(out.systemPrompt).not.toContain("b skill description");
    expect(out.systemPrompt).not.toContain("c skill description");
    expect(out.effectiveSkills.map((s) => s.name)).toEqual(["a"]);
    // Layer order: framework blocks → persona last.
    const personaIdx = out.systemPrompt.indexOf("REVIEWER");
    const skillsIdx = out.systemPrompt.indexOf("<available_skills>");
    expect(personaIdx).toBeGreaterThan(skillsIdx);
  });

  test("project conventions from parent's contextBlock land in the child", () => {
    const out = materialiseForChild({ system_prompt: "PERSONA" }, parentFramework, parentSkills);
    expect(out.systemPrompt).toContain("project AGENTS.md");
  });

  test("agents catalogue is empty for sub-agents — no nesting", () => {
    const out = materialiseForChild({ system_prompt: "PERSONA" }, parentFramework, parentSkills);
    expect(out.systemPrompt).not.toContain("## Available sub-agents");
  });
});

describe("materialiseForChild — Skill tool inheritance", () => {
  // The Skill tool itself is force-included by `PiLlmBackend`
  // regardless of whether the child sees a non-empty skills catalogue.
  // What matters here is the `effectiveSkills` set the loader sees:
  // a `skill({name})` call resolves only against the filtered set.
  const parentSkills: Skill[] = [
    {
      name: "a",
      description: "a desc",
      location: "/skills/a/SKILL.md",
      skill_dir: "/skills/a",
      sha256: "d",
      bytes: 1,
      scope: "user",
      source_dir: "/skills/a",
    },
    {
      name: "b",
      description: "b desc",
      location: "/skills/b/SKILL.md",
      skill_dir: "/skills/b",
      sha256: "d",
      bytes: 1,
      scope: "user",
      source_dir: "/skills/b",
    },
  ];

  test("child can call skill({name: A}) when spec.skills filters to {A}", async () => {
    const filtered = materialiseForChild({ skills: ["a"] }, { contextBlock: "" }, parentSkills);
    expect(filtered.effectiveSkills.map((s) => s.name)).toEqual(["a"]);
    const env = {
      readFile: async () => "---\nname: a\ndescription: a desc\n---\nbody-a",
    };
    const out = await loadSkill(env, "a", undefined, filtered.effectiveSkills);
    expect(out.ok).toBe(true);
  });

  test("child gets unknown-name error for skill({name: B}) when spec.skills filters to {A}", async () => {
    const filtered = materialiseForChild({ skills: ["a"] }, { contextBlock: "" }, parentSkills);
    const env = { readFile: async () => "" };
    const out = await loadSkill(env, "b", undefined, filtered.effectiveSkills);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected failure");
    expect(out.available).toEqual(["a"]);
  });
});
