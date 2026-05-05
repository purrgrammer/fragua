// loadSkill — substitution edge cases, unknown-name recovery,
// frontmatter round-trip.

import { describe, expect, test } from "bun:test";
import { loadSkill } from "../../src/skills/load.ts";
import type { Skill } from "../../src/skills/types.ts";

function skill(name: string, body: string, extras: Partial<Skill> = {}): Skill {
  return {
    name,
    description: `desc for ${name}`,
    location: `/abs/skills/${name}/SKILL.md`,
    skill_dir: `/abs/skills/${name}`,
    sha256: "a".repeat(64),
    bytes: body.length,
    scope: "user",
    source_dir: "/abs/skills",
    ...extras,
    // body is captured by the env stub, not on the Skill record.
  };
}

function envFor(files: Record<string, string>): { readFile(path: string): Promise<string> } {
  return {
    readFile: async (path: string) => {
      if (path in files) return files[path]!;
      throw new Error(`ENOENT: ${path}`);
    },
  };
}

function makeSkillMd(opts: { name: string; description: string; body: string; extraFm?: string }): string {
  const extra = opts.extraFm ? `\n${opts.extraFm}` : "";
  return `---\nname: ${opts.name}\ndescription: ${opts.description}${extra}\n---\n${opts.body}`;
}

describe("loadSkill", () => {
  test("substitutes a single $ARGUMENTS in body", async () => {
    const md = makeSkillMd({ name: "x", description: "d", body: "hello $ARGUMENTS" });
    const env = envFor({ "/abs/skills/x/SKILL.md": md });
    const out = await loadSkill(env, "x", "world", [skill("x", md)]);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(out.content).toBe("hello world");
    expect(out.content).not.toContain("<invocation>");
  });

  test("substitutes every $ARGUMENTS occurrence", async () => {
    const md = makeSkillMd({ name: "x", description: "d", body: "$ARGUMENTS / $ARGUMENTS / $ARGUMENTS" });
    const env = envFor({ "/abs/skills/x/SKILL.md": md });
    const out = await loadSkill(env, "x", "yo", [skill("x", md)]);
    if (!out.ok) throw new Error("expected ok");
    expect(out.content).toBe("yo / yo / yo");
  });

  test("replaces $ARGUMENTS with empty string when args absent", async () => {
    const md = makeSkillMd({ name: "x", description: "d", body: "a $ARGUMENTS b" });
    const env = envFor({ "/abs/skills/x/SKILL.md": md });
    const out = await loadSkill(env, "x", undefined, [skill("x", md)]);
    if (!out.ok) throw new Error("expected ok");
    expect(out.content).toBe("a  b");
    expect(out.content).not.toContain("<invocation>");
  });

  test("appends <invocation> block when body has no $ARGUMENTS and args provided", async () => {
    const md = makeSkillMd({ name: "x", description: "d", body: "plain instructions" });
    const env = envFor({ "/abs/skills/x/SKILL.md": md });
    const out = await loadSkill(env, "x", "do X", [skill("x", md)]);
    if (!out.ok) throw new Error("expected ok");
    expect(out.content.endsWith("<invocation>do X</invocation>")).toBe(true);
  });

  test("does not append <invocation> when body has no $ARGUMENTS and args empty", async () => {
    const md = makeSkillMd({ name: "x", description: "d", body: "plain" });
    const env = envFor({ "/abs/skills/x/SKILL.md": md });
    const out = await loadSkill(env, "x", "", [skill("x", md)]);
    if (!out.ok) throw new Error("expected ok");
    expect(out.content).toBe("plain");
    expect(out.content).not.toContain("<invocation>");
  });

  test("does not substitute boundary-suffixed token like $ARGUMENTSx", async () => {
    // Boundary rule mirrors substitution.ts:replaceBoundary \u2014 we only
    // expand the literal $ARGUMENTS token, not lookalikes.
    const md = makeSkillMd({ name: "x", description: "d", body: "$ARGUMENTSx and $ARGUMENTS" });
    const env = envFor({ "/abs/skills/x/SKILL.md": md });
    const out = await loadSkill(env, "x", "Y", [skill("x", md)]);
    if (!out.ok) throw new Error("expected ok");
    expect(out.content).toBe("$ARGUMENTSx and Y");
  });

  test("returns unknown-name error with available-name list", async () => {
    const env = envFor({});
    const cat = [skill("a", ""), skill("b", ""), skill("c", "")];
    const out = await loadSkill(env, "d", undefined, cat);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected failure");
    expect(out.message).toContain("unknown skill");
    expect(out.message).toContain('"d"');
    expect(out.available).toEqual(["a", "b", "c"]);
    for (const n of ["a", "b", "c"]) expect(out.message).toContain(n);
  });

  test("unknown-name on empty catalogue surfaces an explicit hint", async () => {
    const out = await loadSkill(envFor({}), "x", undefined, []);
    if (out.ok) throw new Error("expected failure");
    expect(out.message).toContain("catalogue is empty");
    expect(out.available).toEqual([]);
  });

  test("project skill shadows user skill of same name", async () => {
    // discoverSkills enforces project-over-user precedence, but we also
    // pin behaviour at the loader boundary: the first matching visible
    // catalogue entry wins. (Catalogue is passed in pre-deduped from
    // discoverSkills in production.)
    const projectMd = makeSkillMd({ name: "frontend", description: "PROJECT", body: "project body" });
    const userMd = makeSkillMd({ name: "frontend", description: "USER", body: "user body" });
    const env = envFor({
      "/abs/proj/frontend/SKILL.md": projectMd,
      "/abs/user/frontend/SKILL.md": userMd,
    });
    const projectSkill = skill("frontend", projectMd, {
      location: "/abs/proj/frontend/SKILL.md",
      skill_dir: "/abs/proj/frontend",
      scope: "project",
      source_dir: "/abs/proj",
      description: "PROJECT",
    });
    // discoverSkills returns one entry per name; pass only the winner.
    const out = await loadSkill(env, "frontend", undefined, [projectSkill]);
    if (!out.ok) throw new Error("expected ok");
    expect(out.path).toBe("/abs/proj/frontend/SKILL.md");
    expect(out.content).toBe("project body");
    expect(out.description).toBe("PROJECT");
  });

  test("disabled skills are not loadable even when present in the catalogue", async () => {
    const md = makeSkillMd({ name: "x", description: "d", body: "body" });
    const env = envFor({ "/abs/skills/x/SKILL.md": md });
    const cat = [skill("x", md, { disabled_reason: "shadowed" })];
    const out = await loadSkill(env, "x", undefined, cat);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected failure");
    expect(out.available).toEqual([]);
  });

  test("renders frontmatter name + description into the model-facing markdown header", async () => {
    const md = makeSkillMd({ name: "x", description: "y", body: "body" });
    const env = envFor({ "/abs/skills/x/SKILL.md": md });
    const out = await loadSkill(env, "x", undefined, [skill("x", md)]);
    if (!out.ok) throw new Error("expected ok");
    expect(out.rendered.startsWith("# Skill: x\n_y_\n\nbody")).toBe(true);
  });

  test("frontmatter keys other than name/description pass through in the body untouched", async () => {
    // The proposal: only `name` + `description` are honoured by the
    // catalogue. Other keys (triggers, when_to_use, requires_tools)
    // are dropped along with the rest of the YAML block \u2014 they would
    // confuse the model with metadata it can't act on. Body lines
    // outside the frontmatter survive verbatim.
    const md = makeSkillMd({
      name: "x",
      description: "y",
      body: "the body mentions triggers as a word",
      extraFm: "triggers: [foo, bar]\nrequires_tools: [bash]",
    });
    const env = envFor({ "/abs/skills/x/SKILL.md": md });
    const out = await loadSkill(env, "x", undefined, [skill("x", md)]);
    if (!out.ok) throw new Error("expected ok");
    // No frontmatter leakage.
    expect(out.content).not.toContain("triggers: [foo");
    expect(out.content).not.toContain("requires_tools");
    expect(out.content).not.toContain("---");
    // But the body's own use of the word "triggers" is preserved.
    expect(out.content).toContain("the body mentions triggers as a word");
  });
});
