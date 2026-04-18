// Render the tier-1 catalog block prepended to the agent's system prompt.
// One XML block per call — the agent sees this at session start, decides
// whether a skill applies, and calls `local:load_skill` to pull the body.

import type { Skill, SkillCatalogRecord } from "./types.ts";

const BEHAVIORAL_INSTRUCTIONS = [
  "The following skills provide specialized instructions for specific tasks.",
  "When a task matches a skill's description, call the local:load_skill tool",
  "with the skill's name to load its full instructions before proceeding.",
  "Relative paths inside a skill are resolved against the skill directory",
  "returned in the load_skill result — use absolute paths when calling tools.",
].join(" ");

export function renderSkillsCatalog(skills: readonly Skill[]): string {
  const visible = skills.filter((s) => !s.disabled_reason);
  if (visible.length === 0) return "";
  const entries = visible.map((s) => {
    return [
      "  <skill>",
      `    <name>${escapeXml(s.name)}</name>`,
      `    <description>${escapeXml(s.description)}</description>`,
      `    <location>${escapeXml(s.location)}</location>`,
      "  </skill>",
    ].join("\n");
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
  };
}

function escapeXml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
