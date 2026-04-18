// Skill discovery. Scans well-known paths by default; honours an explicit
// `skills.paths` override from `.swarm/config.yaml`.
//
// Precedence on name collision: project scope beats user scope. Within the
// same scope, the path listed earlier wins (swarm-native before cross-client
// interop before Claude compat). Collisions emit a warning that surfaces
// on the loser's `disabled_reason`.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseSkillMd } from "./parse.ts";
import type { DiscoverOptions, Skill, SkillScope, SkillsConfig } from "./types.ts";

/** Well-known paths, project before user. See docs/skills.md. */
const PROJECT_WELL_KNOWN = [".agents/skills", ".claude/skills"] as const;
const USER_WELL_KNOWN = [".agents/skills", ".claude/skills"] as const;

export interface DiscoverResult {
  skills: Skill[];
  warnings: string[];
}

export async function discoverSkills(opts: DiscoverOptions): Promise<DiscoverResult> {
  const config = opts.config ?? {};
  const trustProject = config.trust_project ?? true;
  const disabledSet = new Set(config.disabled ?? []);

  const roots = buildRoots(opts, config);
  const warnings: string[] = [];
  const byName = new Map<string, Skill>();

  for (const root of roots) {
    const skillsFromRoot = await scanRoot(root.path, root.scope);
    for (const skill of skillsFromRoot) {
      // skills.disabled is an exclusion list: drop matching skills before
      // the precedence merge so they're absent from the catalog, GET /skills,
      // and the web UI — the user's intent is "pretend this isn't installed".
      // For soft-hiding that still surfaces in /skills, see trust_project.
      if (disabledSet.has(skill.name)) continue;
      if (skill.scope === "project" && !trustProject) {
        skill.disabled_reason = "project scope hidden (skills.trust_project=false)";
      }

      const existing = byName.get(skill.name);
      if (!existing) {
        byName.set(skill.name, skill);
        continue;
      }
      // Project always beats user. Within the same scope, earlier root wins.
      const existingRank = scopeRank(existing.scope);
      const newRank = scopeRank(skill.scope);
      if (newRank < existingRank) {
        warnings.push(`skill "${skill.name}" at ${existing.location} shadowed by ${skill.location}`);
        byName.set(skill.name, skill);
      } else {
        warnings.push(`skill "${skill.name}" at ${skill.location} shadowed by ${existing.location}`);
      }
    }
  }

  return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
}

interface Root {
  path: string;
  scope: SkillScope;
}

function buildRoots(opts: DiscoverOptions, config: SkillsConfig): Root[] {
  if (config.paths && config.paths.length > 0) {
    // Explicit list disables auto-discovery. Relative paths resolve against
    // cwd; absolute paths are honoured as-is. Scope is inferred: anything
    // under cwd is "project", anything under homeDir is "user", otherwise
    // "project" (closest practical match for a vendored directory).
    return config.paths.map((p) => {
      const abs = isAbsolute(p) ? p : resolve(opts.cwd, p);
      const scope: SkillScope =
        opts.homeDir && abs.startsWith(opts.homeDir) && !abs.startsWith(opts.cwd) ? "user" : "project";
      return { path: abs, scope };
    });
  }

  const roots: Root[] = [];
  for (const rel of PROJECT_WELL_KNOWN) {
    roots.push({ path: resolve(opts.cwd, rel), scope: "project" });
  }
  if (opts.homeDir) {
    for (const rel of USER_WELL_KNOWN) {
      roots.push({ path: resolve(opts.homeDir, rel), scope: "user" });
    }
  }
  return roots;
}

function scopeRank(scope: SkillScope): number {
  return scope === "project" ? 0 : 1;
}

async function scanRoot(rootPath: string, scope: SkillScope): Promise<Skill[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = (await readdir(rootPath, { withFileTypes: true })) as unknown as Array<{
      name: string;
      isDirectory: () => boolean;
    }>;
  } catch {
    return []; // missing dir is fine — skill roots are optional
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const skillDir = resolve(rootPath, entry.name);
    const mdPath = resolve(skillDir, "SKILL.md");
    let raw: string;
    let bytes: number;
    try {
      const s = await stat(mdPath);
      if (!s.isFile()) continue;
      raw = await readFile(mdPath, "utf8");
      bytes = s.size;
    } catch {
      continue; // no SKILL.md in this dir
    }

    const parsed = parseSkillMd(raw);
    const fm = parsed.frontmatter;
    const fmName = fm["name"];
    const fmDesc = fm["description"];
    const fmVersion = fm["version"];
    const fmAllowed = fm["allowed_tools"];
    const name = typeof fmName === "string" ? fmName : entry.name;
    const description = typeof fmDesc === "string" ? fmDesc : "";
    if (!description) {
      // Per the spec, skip skills with no description — without one they
      // can't be meaningfully advertised in the catalog.
      continue;
    }
    const version = typeof fmVersion === "string" ? fmVersion : undefined;
    const allowed_tools = Array.isArray(fmAllowed)
      ? fmAllowed.filter((t): t is string => typeof t === "string")
      : undefined;

    skills.push({
      name,
      description,
      ...(version !== undefined ? { version } : {}),
      ...(allowed_tools !== undefined ? { allowed_tools } : {}),
      location: mdPath,
      skill_dir: skillDir,
      sha256: sha256Hex(raw),
      bytes,
      scope,
      source_dir: rootPath,
    });
  }
  return skills;
}

function sha256Hex(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}
