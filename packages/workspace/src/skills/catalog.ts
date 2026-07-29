// Render the tier-1 catalog block prepended to the agent's system prompt.
// One XML block per call — the agent sees this at session start, decides
// whether a skill applies, and loads the body via the built-in `skill`
// tool. The tool reads SKILL.md, parses frontmatter, substitutes
// $ARGUMENTS, and returns the rendered body — work the model would
// otherwise spend tokens doing inline against a `read` result.

import { byName } from "@fragua/core";
import type { Skill, SkillCatalogRecord } from "./types.ts";

const BEHAVIORAL_INSTRUCTIONS = [
  "The following skills provide specialized instructions for specific tasks.",
  "When a task matches a skill's description, call the `skill` tool with",
  '`{ name: "<name>", arguments: "..." }` to load it. The arguments',
  "string replaces $ARGUMENTS in the skill body, or is appended as an",
  "<invocation>...</invocation> block when the body has no placeholder.",
  "When a skill references relative paths (scripts/, references/, assets/),",
  "resolve them against the skill's directory (the parent of the",
  "<location> path) and use absolute paths in tool calls.",
].join(" ");

export function renderSkillsCatalog(skills: readonly Skill[]): string {
  // Sort at the point of RENDER, not only at discovery. This block is part of
  // the provider's prompt-cache prefix, so its bytes must be a function of the
  // effective skill set alone — not of how the caller happened to assemble the
  // list. `discoverSkills` already sorts, but that only covers callers that
  // came through discovery; filtering, merging, or any future assembly path
  // would otherwise reintroduce an order dependency here with nothing to catch
  // it. Same reasoning as the backend's final `tools.sort(byName)`.
  const visible = skills.filter((s) => !s.disabled_reason).sort(byName);
  if (visible.length === 0) return "";
  const entries = visible.map((s) => {
    const lines = [
      "  <skill>",
      `    <name>${escapeXml(s.name)}</name>`,
      `    <description>${escapeXml(s.description)}</description>`,
    ];
    if (s.compatibility) {
      lines.push(`    <compatibility>${escapeXml(s.compatibility)}</compatibility>`);
    }
    lines.push(`    <location>${escapeXml(s.location)}</location>`, "  </skill>");
    return lines.join("\n");
  });
  return ["<available_skills>", ...entries, "</available_skills>", "", BEHAVIORAL_INSTRUCTIONS].join("\n");
}

/** Filter a catalog by node-level attrs. Unset `allow` = all skills; set =
 * intersection by name. `disabled` hides from the catalog entirely. */
export function filterSkillsForNode(
  skills: readonly Skill[],
  attrs: { skills?: readonly string[]; skills_disabled?: boolean },
): Skill[] {
  if (attrs.skills_disabled) return [];
  if (!attrs.skills || attrs.skills.length === 0) return skills.filter((s) => !s.disabled_reason);
  const allow = new Set(attrs.skills);
  return skills.filter((s) => !s.disabled_reason && allow.has(s.name));
}

/** Project the discovery superset down to the slice a single run can see.
 *
 * Two responsibilities:
 *   1. Scope/cwd filter — keep `scope === "user"` records and project
 *      records whose `project_cwd` matches `runCwd`.
 *   2. Cross-scope shadow — within the filtered slice, project-scope
 *      records shadow user-scope records by name. Discovery emits both;
 *      this is where the "project beats user" rule materialises.
 *
 * Returns a fresh array in discovery order — **do not re-sort it**. Discovery
 * already orders byte-wise (`discover.ts`), `filter` preserves that order, and
 * this catalogue renders into the `<available_skills>` block of the system
 * prompt, which is part of the provider's prompt-cache prefix. A well-meaning
 * `localeCompare` here would make that prefix machine-dependent with no type
 * or lint error to catch it.
 */
export function filterCatalogueForRun(skills: readonly Skill[], runCwd: string): Skill[] {
  const slice = skills.filter((s) => s.scope === "user" || s.project_cwd === runCwd);
  const projectNames = new Set(slice.filter((s) => s.scope === "project").map((s) => s.name));
  return slice.filter((s) => s.scope === "project" || !projectNames.has(s.name));
}

/** Project a skill down to the event-log subset. Only visible skills end up
 * on `llm.start.skills[]` — disabled_reason ones never reached the model. */
export function toCatalogRecord(s: Skill): SkillCatalogRecord {
  return {
    name: s.name,
    location: s.location,
    sha256: s.sha256,
    bytes: s.bytes,
    scope: s.scope,
    source_dir: s.source_dir,
    ...(s.project_cwd !== undefined ? { project_cwd: s.project_cwd } : {}),
    ...(s.compatibility !== undefined ? { compatibility: s.compatibility } : {}),
  };
}

function escapeXml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
