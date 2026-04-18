// Tier-2 loader. Builds a `local:load_skill` tool whose `name` parameter is
// constrained to the set of discovered skill names (TypeBox enum of literals)
// so the model can't hallucinate ids. Returns the SKILL.md body wrapped in
// `<skill_content>` tags alongside a (non-eager) listing of bundled
// resources — the spec calls this out as the right shape because it lets
// the model cleanly identify skill content during context management and
// see what scripts/references are available without reading them upfront.

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { Type } from "@sinclair/typebox";
import type { Tool } from "../types.ts";
import { stripFrontmatter } from "./parse.ts";
import type { Skill } from "./types.ts";

const MAX_RESOURCES_LISTED = 64;

export function buildLoadSkillTool(
  skills: readonly Skill[],
): Tool<{ name: string }, { skill_dir: string; resources: string[] }> {
  const visible = skills.filter((s) => !s.disabled_reason);
  if (visible.length === 0) {
    throw new Error("buildLoadSkillTool requires at least one visible skill");
  }
  const byName = new Map(visible.map((s) => [s.name, s]));
  const literals = visible.map((s) => Type.Literal(s.name));
  // Type.Union requires >= 2 literals; with exactly one, fall back to a plain literal.
  const nameSchema = literals.length === 1 ? literals[0]! : Type.Union(literals);

  return {
    name: "local:load_skill",
    description:
      "Load the full instructions for a named skill advertised in <available_skills>. Use this when a task matches a skill's description — the returned body contains the detailed workflow. Resources listed under <skill_resources> can be read separately with local:read_file.",
    parameters: Type.Object({
      name: nameSchema,
    }),
    idempotent: true,
    truncation: { max_chars: 50_000, mode: "tail" },
    async execute(args, env) {
      const skill = byName.get(args.name);
      if (!skill) {
        return { text: `unknown skill: ${args.name}`, is_error: true };
      }
      let raw: string;
      try {
        raw = await env.readFile(skill.location);
      } catch (err) {
        return {
          text: `could not read SKILL.md at ${skill.location}: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        };
      }
      const body = stripFrontmatter(raw);
      const resources = await listResources(skill.skill_dir);
      const wrapped = wrapSkillContent(skill, body, resources);
      return { text: wrapped, data: { skill_dir: skill.skill_dir, resources } };
    },
  };
}

export function wrapSkillContent(skill: Skill, body: string, resources: string[]): string {
  const lines = [`<skill_content name="${escapeAttr(skill.name)}">`, body, "", `Skill directory: ${skill.skill_dir}`];
  if (resources.length > 0) {
    lines.push("<skill_resources>");
    for (const r of resources) lines.push(`  <file>${escapeXml(r)}</file>`);
    lines.push("</skill_resources>");
  }
  lines.push("</skill_content>");
  return lines.join("\n");
}

async function listResources(dir: string): Promise<string[]> {
  const out: string[] = [];
  await walk(dir, dir, out, 0);
  out.sort();
  if (out.length > MAX_RESOURCES_LISTED) {
    out.length = MAX_RESOURCES_LISTED;
    out.push("[resource listing truncated — inspect the skill directory for more]");
  }
  return out;
}

async function walk(root: string, current: string, out: string[], depth: number): Promise<void> {
  if (depth > 4) return;
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = (await readdir(current, { withFileTypes: true })) as unknown as Array<{
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
    }>;
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.name === "SKILL.md" && current === root) continue;
    const abs = join(current, e.name);
    if (e.isDirectory()) {
      await walk(root, abs, out, depth + 1);
    } else if (e.isFile()) {
      out.push(relative(root, abs));
    }
  }
}

function escapeAttr(v: string): string {
  return v.replace(/"/g, "&quot;");
}
function escapeXml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
