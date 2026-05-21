import { describe, expect, test } from "bun:test";
import type { AgentDefinition } from "@fragua/types";
import { filterAgentsCatalogueForRun, lookupAgentDef, renderAgentsCatalog } from "../../src/agents/catalog.ts";

function mk(name: string, description: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name,
    description,
    body: "body",
    location: `/tmp/${name}.md`,
    sha256: "0".repeat(64),
    bytes: 1,
    scope: "project",
    source_dir: "/tmp",
    ...extra,
  };
}

describe("renderAgentsCatalog", () => {
  test("renders one bullet per profile with name + description", () => {
    const out = renderAgentsCatalog([mk("reviewer", "Reviews diffs."), mk("researcher", "Reads docs and answers.")]);
    expect(out).toContain("## Available sub-agents");
    expect(out).toContain("- `researcher` — Reads docs and answers.");
    expect(out).toContain("- `reviewer` — Reviews diffs.");
    // sorted alphabetically: researcher before reviewer
    const idxResearcher = out.indexOf("`researcher`");
    const idxReviewer = out.indexOf("`reviewer`");
    expect(idxResearcher).toBeLessThan(idxReviewer);
  });

  test("returns empty string when no profiles", () => {
    expect(renderAgentsCatalog([])).toBe("");
  });

  test("disabled defs are skipped", () => {
    const out = renderAgentsCatalog([mk("hidden", "x", { disabled_reason: "test" }), mk("shown", "y")]);
    expect(out).not.toContain("hidden");
    expect(out).toContain("shown");
  });
});

describe("lookupAgentDef", () => {
  test("returns the def for a known name; undefined otherwise", () => {
    const cat = [mk("alpha", "a"), mk("beta", "b")];
    expect(lookupAgentDef(cat, "alpha")?.description).toBe("a");
    expect(lookupAgentDef(cat, "missing")).toBeUndefined();
  });

  test("disabled defs do not resolve", () => {
    const cat = [mk("hidden", "h", { disabled_reason: "test" })];
    expect(lookupAgentDef(cat, "hidden")).toBeUndefined();
  });
});

describe("filterAgentsCatalogueForRun", () => {
  const userReviewer = mk("reviewer", "user reviewer", { scope: "user", source_dir: "/home/.agents/agents" });
  const projAReviewer = mk("reviewer", "A's reviewer", {
    project_cwd: "/projects/a",
    location: "/projects/a/.agents/agents/reviewer.md",
  });
  const projBReviewer = mk("reviewer", "B's reviewer", {
    project_cwd: "/projects/b",
    location: "/projects/b/.agents/agents/reviewer.md",
  });
  const projAOnly = mk("aOnly", "project A only", {
    project_cwd: "/projects/a",
    location: "/projects/a/.agents/agents/aOnly.md",
  });
  const superset = [userReviewer, projAReviewer, projBReviewer, projAOnly];

  test("returns user-scope + project records matching runCwd; project shadows user", () => {
    const slice = filterAgentsCatalogueForRun(superset, "/projects/a");
    const names = slice.map((d) => d.name).sort();
    expect(names).toEqual(["aOnly", "reviewer"]);
    const reviewer = slice.find((d) => d.name === "reviewer");
    expect(reviewer?.scope).toBe("project");
    expect(reviewer?.description).toBe("A's reviewer");
  });

  test("excludes other projects' records", () => {
    const slice = filterAgentsCatalogueForRun(superset, "/projects/a");
    expect(slice.find((d) => d.location.includes("projects/b"))).toBeUndefined();
  });

  test("unknown runCwd surfaces user-scope only", () => {
    const slice = filterAgentsCatalogueForRun(superset, "/projects/never-seen");
    expect(slice.map((d) => d.name)).toEqual(["reviewer"]);
    expect(slice[0]?.scope).toBe("user");
  });
});
