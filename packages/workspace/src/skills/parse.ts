// Lenient YAML frontmatter parser for SKILL.md. The spec (agentskills.io
// §"Handling malformed YAML") warns that skill files authored for other
// clients frequently contain technically-invalid YAML — the most common
// issue being unquoted values with colons in the description. We retry
// with the description value quoted before giving up.

import YAML from "yaml";
import type { ParsedSkillMd } from "./types.ts";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseSkillMd(contents: string): ParsedSkillMd {
  const warnings: string[] = [];
  const match = contents.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: contents.trim(), warnings: ["SKILL.md has no YAML frontmatter"] };
  }
  const rawFrontmatter = match[1] ?? "";
  const body = contents.slice(match[0].length).trim();

  let frontmatter: Record<string, unknown>;
  try {
    const parsed = YAML.parse(rawFrontmatter);
    frontmatter = isRecord(parsed) ? parsed : {};
  } catch (err) {
    // Retry with unquoted-colon-in-description quoted. Covers the common
    // "description: Use this skill when: the user asks…" shape.
    const repaired = quoteUnquotedColonValues(rawFrontmatter);
    if (repaired !== rawFrontmatter) {
      try {
        const parsed = YAML.parse(repaired);
        frontmatter = isRecord(parsed) ? parsed : {};
        warnings.push("repaired unquoted-colon values in frontmatter before parsing");
      } catch {
        warnings.push(`frontmatter YAML unparseable: ${err instanceof Error ? err.message : String(err)}`);
        frontmatter = {};
      }
    } else {
      warnings.push(`frontmatter YAML unparseable: ${err instanceof Error ? err.message : String(err)}`);
      frontmatter = {};
    }
  }

  return { frontmatter, body, warnings };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Wrap bare values containing a colon in double quotes on a best-effort basis.
 * Only touches top-level `key: value` lines where `value` is not already
 * quoted / a block scalar / an array / an object. */
function quoteUnquotedColonValues(yaml: string): string {
  return yaml
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+)$/);
      if (!m) return line;
      const key = m[1]!;
      const value = m[2]!.trim();
      if (!value.includes(":")) return line;
      if (/^["'[{|>]/.test(value)) return line; // already quoted / block / array / object
      const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `${key}: "${escaped}"`;
    })
    .join("\n");
}

/** Strip the YAML frontmatter block from a SKILL.md so the model only sees
 * the markdown body (used by the tier-2 load_skill tool result). */
export function stripFrontmatter(contents: string): string {
  const m = contents.match(FRONTMATTER_RE);
  return m ? contents.slice(m[0].length).trim() : contents.trim();
}
