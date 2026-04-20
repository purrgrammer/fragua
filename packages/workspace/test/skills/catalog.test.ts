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
    // Instructions direct the agent to read the SKILL.md with the `read`
    // tool — no dedicated load_skill tool under the trimmed surface.
    expect(out).toContain("`read`");
    expect(out).toContain("SKILL.md");
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
});
