// Lenient YAML frontmatter parser for agent-definition `.md` files.
// Mirrors `skills/parse.ts` — same retry policy for the common
// "description: Use when: …" unquoted-colon shape that breaks YAML.
// Kept as a thin wrapper rather than refactored into a shared helper
// to keep the skills loader's blast radius unchanged; the duplication
// is ~30 lines and the policies are allowed to diverge later (e.g.
// agent files might add their own field-level repair rules).

import YAML from "yaml";
import type { ParsedAgentMd } from "./types.ts";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseAgentMd(contents: string): ParsedAgentMd {
  const warnings: string[] = [];
  const match = contents.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: contents.trim(), warnings: ["agent .md has no YAML frontmatter"] };
  }
  const rawFrontmatter = match[1] ?? "";
  const body = contents.slice(match[0].length).trim();

  let frontmatter: Record<string, unknown>;
  try {
    const parsed = YAML.parse(rawFrontmatter);
    frontmatter = isRecord(parsed) ? parsed : {};
  } catch (err) {
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

function quoteUnquotedColonValues(yaml: string): string {
  return yaml
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+)$/);
      if (!m) return line;
      const key = m[1]!;
      const value = m[2]!.trim();
      if (!value.includes(":")) return line;
      if (/^["'[{|>]/.test(value)) return line;
      const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `${key}: "${escaped}"`;
    })
    .join("\n");
}
