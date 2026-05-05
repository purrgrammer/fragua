import { describe, expect, test } from "bun:test";
import {
  filterCatalogueForRun,
  filterSkillsForNode,
  renderSkillsCatalog,
  toCatalogRecord,
} from "../../src/skills/catalog.ts";
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

  test("forwards project_cwd when set so replay can correlate per-run filtering", () => {
    const rec = toCatalogRecord(skill("frontend", { scope: "project", project_cwd: "/projects/a" }));
    expect(rec.project_cwd).toBe("/projects/a");
  });

  test("omits project_cwd when unset (user-scope records)", () => {
    const rec = toCatalogRecord(skill("plain"));
    expect("project_cwd" in rec).toBe(false);
  });
});

describe("filterCatalogueForRun", () => {
  const userPdf = skill("pdf");
  const userFrontend = skill("frontend", { description: "user frontend" });
  const projAFrontend = skill("frontend", {
    scope: "project",
    project_cwd: "/projects/a",
    description: "A's frontend",
    location: "/projects/a/.agents/skills/frontend/SKILL.md",
  });
  const projBFrontend = skill("frontend", {
    scope: "project",
    project_cwd: "/projects/b",
    description: "B's frontend",
    location: "/projects/b/.agents/skills/frontend/SKILL.md",
  });
  const projAOnly = skill("aOnly", {
    scope: "project",
    project_cwd: "/projects/a",
    location: "/projects/a/.agents/skills/aOnly/SKILL.md",
  });
  const superset: Skill[] = [userPdf, userFrontend, projAFrontend, projBFrontend, projAOnly];

  test("returns user-scope records and project records matching runCwd", () => {
    const slice = filterCatalogueForRun(superset, "/projects/a");
    const names = slice.map((s) => s.name).sort();
    expect(names).toEqual(["aOnly", "frontend", "pdf"]);
  });

  test("project-scope shadows user-scope by name within the slice", () => {
    const slice = filterCatalogueForRun(superset, "/projects/a");
    const frontend = slice.find((s) => s.name === "frontend");
    expect(frontend?.scope).toBe("project");
    expect(frontend?.description).toBe("A's frontend");
  });

  test("the OTHER project's records are excluded", () => {
    const slice = filterCatalogueForRun(superset, "/projects/a");
    expect(slice.find((s) => s.location.includes("projects/b"))).toBeUndefined();
  });

  test("unknown runCwd surfaces user-scope only (no project records match)", () => {
    const slice = filterCatalogueForRun(superset, "/projects/never-seen");
    const names = slice.map((s) => s.name).sort();
    expect(names).toEqual(["frontend", "pdf"]);
    // Without a project record to shadow, the user-scope frontend wins.
    const frontend = slice.find((s) => s.name === "frontend");
    expect(frontend?.scope).toBe("user");
    expect(frontend?.description).toBe("user frontend");
  });

  test("empty input → empty slice", () => {
    expect(filterCatalogueForRun([], "/anywhere")).toEqual([]);
  });
});
