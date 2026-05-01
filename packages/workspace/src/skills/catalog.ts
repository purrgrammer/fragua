// Render the tier-1 catalog block prepended to the agent's system prompt.
// One XML block per call — the agent sees this at session start, decides
// whether a skill applies, and reads the SKILL.md at `<location>` using
// the `read` tool. Skill loading happens through `read` rather than a
// dedicated tool because the catalog is already in the prompt and the
// SKILL.md path is right there — a separate tool would just round-trip
// state the agent already holds.

import type { Skill, SkillCatalogRecord } from "./types.ts";

const BEHAVIORAL_INSTRUCTIONS = [
  "The following skills provide specialized instructions for specific tasks.",
  "When a task matches a skill's description, read the SKILL.md at the",
  "<location> path below using the `read` tool; the body contains the",
  "detailed workflow. When a skill references relative paths (scripts/,",
  "references/, assets/), resolve them against the skill's directory (the",
  "parent of SKILL.md) and use absolute paths in tool calls.",
].join(" ");

export function renderSkillsCatalog(skills: readonly Skill[]): string {
  const visible = skills.filter((s) => !s.disabled_reason);
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
    ...(s.compatibility !== undefined ? { compatibility: s.compatibility } : {}),
  };
}

function escapeXml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
