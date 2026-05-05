import { describe, expect, test } from "bun:test";
import { filterSkillsForNode, renderSkillsCatalog, toCatalogRecord } from "../../src/skills/catalog.ts";
import type { Skill } from "../../src/skills/types.ts";

function skill(name: string, extras: Partial<Skill> = {}): Skill {
  return {
    name,
    description: `desc for ${name}`,
    location: `/abs/skills/${name}/SKILL.md`,
    skill_dir: `/abs/skills/${name}`,
    sha256: "a".repeat(64),
    bytes: 100,
    scope: "user",
    source_dir: "/abs/skills",
    ...extras,
  };
}

describe("renderSkillsCatalog", () => {
  test("returns empty string when no visible skills", () => {
    expect(renderSkillsCatalog([])).toBe("");
    expect(renderSkillsCatalog([skill("x", { disabled_reason: "hidden" })])).toBe("");
  });

  test("wraps visible skills in <available_skills> with behavioural instructions", () => {
    const out = renderSkillsCatalog([skill("pdf"), skill("csv")]);
    expect(out).toContain("<available_skills>");
    expect(out).toContain("<name>pdf</name>");
    expect(out).toContain("<name>csv</name>");
    // Instructions direct the agent to load skills via the built-in
    // `skill` tool — not by reading SKILL.md with `read` (was the
    // pre-skill-tool convention).
    expect(out).toContain("`skill` tool");
    expect(out).toContain("$ARGUMENTS");
    expect(out).toContain("<invocation>");
    // Spec wording: relative paths resolve against the skill's directory
    // and tool calls should use absolute paths.
    expect(out).toContain("absolute paths");
    expect(out).toContain("<location>");
  });

  test("emits <compatibility> only when set on the skill", () => {
    const withC = renderSkillsCatalog([skill("py", { compatibility: "Requires Python 3.14+" })]);
    expect(withC).toContain("<compatibility>Requires Python 3.14+</compatibility>");

    const withoutC = renderSkillsCatalog([skill("plain")]);
    expect(withoutC).not.toContain("<compatibility>");
  });

  test("escapes XML special characters in name/description", () => {
    const s = skill("s", { description: 'quotes " and <tags>' });
    const out = renderSkillsCatalog([s]);
    expect(out).toContain("&quot;");
    expect(out).toContain("&lt;tags&gt;");
  });
});

describe("filterSkillsForNode", () => {
  const skills = [skill("pdf"), skill("csv"), skill("hidden", { disabled_reason: "hidden" })];

  test("returns all visible when allow is unset", () => {
    expect(filterSkillsForNode(skills, {}).map((s) => s.name)).toEqual(["pdf", "csv"]);
  });

  test("intersects with allow list", () => {
    expect(filterSkillsForNode(skills, { skills: ["pdf"] }).map((s) => s.name)).toEqual(["pdf"]);
  });

  test("skills_disabled hides everything", () => {
    expect(filterSkillsForNode(skills, { skills_disabled: true })).toEqual([]);
  });
});

describe("toCatalogRecord", () => {
  test("preserves name/location/sha256/bytes/scope/source_dir", () => {
    const rec = toCatalogRecord(skill("pdf"));
    expect(rec).toEqual({
      name: "pdf",
      location: "/abs/skills/pdf/SKILL.md",
      sha256: "a".repeat(64),
      bytes: 100,
      scope: "user",
      source_dir: "/abs/skills",
    });
  });

  test("forwards compatibility when set so replay can correlate env mismatches", () => {
    const rec = toCatalogRecord(skill("py", { compatibility: "Requires Python 3.14+" }));
    expect(rec.compatibility).toBe("Requires Python 3.14+");
  });

  test("omits compatibility when unset", () => {
    const rec = toCatalogRecord(skill("plain"));
    expect("compatibility" in rec).toBe(false);
  });
});
