// Skill discovery. Walks `~/.agents`, `~/.claude` and every project cwd
// passed in `projectCwds`, emitting a superset of records. Project-scope
// records carry `project_cwd`; the codergen-time filter prunes to a
// single project per run.
//
// Within-bucket precedence: for project scope, `.agents/skills` beats
// `.claude/skills` per cwd; for user scope, same order. Cross-scope
// (project↔user) and cross-project shadowing is NOT applied at discovery
// — both happen at codergen filter time, since the answer depends on
// `run.cwd`. See `filterCatalogueForRun` in `catalog.ts`.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseSkillMd } from "./parse.ts";
import type { DiscoverOptions, Skill, SkillScope, SkillsConfig } from "./types.ts";

/** Well-known relative paths under each cwd / homeDir. Order matters —
 * earlier entries win on within-scope name collisions. */
const PROJECT_WELL_KNOWN = [".agents/skills", ".claude/skills"] as const;
const USER_WELL_KNOWN = [".agents/skills", ".claude/skills"] as const;

export interface DiscoverResult {
  skills: Skill[];
  warnings: string[];
}

interface Root {
  path: string;
  scope: SkillScope;
  /** Set when `scope === "project"`. */
  projectCwd?: string;
}

export async function discoverSkills(opts: DiscoverOptions): Promise<DiscoverResult> {
  const config = opts.config ?? {};
  const trustProject = config.trustProject ?? true;
  const disabledSet = new Set(config.disabled ?? []);

  const roots = buildRoots(opts, config);
  const warnings: string[] = [];

  // Two dedup buckets so cross-scope shadowing is deferred:
  //   project: keyed by `(project_cwd, name)` — same name in two
  //            different projects coexists; same name across the two
  //            project roots within one cwd shadows (earlier wins).
  //   user:    keyed by `name` — single user scope, two roots,
  //            earlier wins.
  const projectByCwdName = new Map<string, Map<string, Skill>>();
  const userByName = new Map<string, Skill>();

  for (const root of roots) {
    const fromRoot = await scanRoot(root.path, root.scope, warnings);
    for (const skill of fromRoot) {
      if (disabledSet.has(skill.name)) continue;
      if (skill.scope === "project") {
        if (!trustProject) {
          skill.disabled_reason = "project scope hidden (skills.trustProject=false)";
        }
        if (root.projectCwd !== undefined) {
          skill.project_cwd = root.projectCwd;
        }
        const cwdKey = root.projectCwd ?? "";
        let inner = projectByCwdName.get(cwdKey);
        if (!inner) {
          inner = new Map();
          projectByCwdName.set(cwdKey, inner);
        }
        const existing = inner.get(skill.name);
        if (!existing) {
          inner.set(skill.name, skill);
        } else {
          warnings.push(`skill "${skill.name}" at ${skill.location} shadowed by ${existing.location}`);
        }
      } else {
        const existing = userByName.get(skill.name);
        if (!existing) {
          userByName.set(skill.name, skill);
        } else {
          warnings.push(`skill "${skill.name}" at ${skill.location} shadowed by ${existing.location}`);
        }
      }
    }
  }

  const out: Skill[] = [];
  for (const inner of projectByCwdName.values()) for (const s of inner.values()) out.push(s);
  for (const s of userByName.values()) out.push(s);
  // Stable sort: name, then user-before-project, then project_cwd asc.
  out.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    if (a.scope !== b.scope) return a.scope === "user" ? -1 : 1;
    return (a.project_cwd ?? "").localeCompare(b.project_cwd ?? "");
  });
  return { skills: out, warnings };
}

function buildRoots(opts: DiscoverOptions, config: SkillsConfig): Root[] {
  if (config.paths && config.paths.length > 0) {
    // Explicit list disables auto-discovery. Scope is inferred:
    //   - under any of `projectCwds` → project, `project_cwd` = that cwd
    //   - under `homeDir` (and not under any project) → user
    //   - otherwise → project with no `project_cwd` (degraded record;
    //     codergen filter will exclude it because it can't match any
    //     `run.cwd`, but the UI still surfaces it)
    // Relative paths resolve against `projectCwds[0]` if any, else
    // `homeDir`. Absolute paths are honoured as-is.
    const anchor = opts.projectCwds[0] ?? opts.homeDir;
    return config.paths.map((p) => {
      const abs = isAbsolute(p) ? p : resolve(anchor, p);
      const projectMatch = opts.projectCwds.find((cwd) => abs.startsWith(cwd));
      if (projectMatch !== undefined) {
        return { path: abs, scope: "project", projectCwd: projectMatch };
      }
      if (opts.homeDir && abs.startsWith(opts.homeDir)) {
        return { path: abs, scope: "user" };
      }
      return { path: abs, scope: "project" };
    });
  }

  const roots: Root[] = [];
  for (const cwd of opts.projectCwds) {
    for (const rel of PROJECT_WELL_KNOWN) {
      roots.push({ path: resolve(cwd, rel), scope: "project", projectCwd: cwd });
    }
  }
  if (opts.homeDir) {
    for (const rel of USER_WELL_KNOWN) {
      roots.push({ path: resolve(opts.homeDir, rel), scope: "user" });
    }
  }
  return roots;
}

/** Spec constraints (agentskills.io §SKILL.md format). Enforced as
 * warnings, not skips — lenient validation per the client-implementation
 * guide, so cross-client skills load even if they bend the rules. */
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const COMPATIBILITY_MAX = 500;
/** Body-size soft cap: spec recommends <500 lines / <5000 tokens.
 * Approximated by line count alone — cheaper than tokenizing, and the
 * line-count rule is the one most authors actually breach. */
const BODY_LINES_SOFT_CAP = 500;
const NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$/;

async function scanRoot(rootPath: string, scope: SkillScope, warnings: string[]): Promise<Skill[]> {
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
    const dirName = entry.name;
    const fmName = fm["name"];
    const fmDesc = fm["description"];
    const fmVersion = fm["version"];
    const name = typeof fmName === "string" ? fmName : dirName;
    const description = typeof fmDesc === "string" ? fmDesc : "";
    if (!description) {
      // Per the spec, skip skills with no description — without one they
      // can't be meaningfully advertised in the catalog.
      warnings.push(`skill at ${mdPath}: missing or empty description (skipped)`);
      continue;
    }

    // ── Lenient validation: warn, never skip ──────────────────────────
    if (name.length > NAME_MAX) {
      warnings.push(`skill at ${mdPath}: name "${name}" exceeds ${NAME_MAX} chars`);
    }
    if (!NAME_RE.test(name)) {
      warnings.push(
        `skill at ${mdPath}: name "${name}" violates spec charset (lowercase a-z, 0-9, hyphen; no leading/trailing or consecutive hyphens)`,
      );
    }
    if (name !== dirName) {
      warnings.push(`skill at ${mdPath}: frontmatter name "${name}" does not match directory "${dirName}"`);
    }
    if (description.length > DESCRIPTION_MAX) {
      warnings.push(`skill at ${mdPath}: description ${description.length} chars exceeds ${DESCRIPTION_MAX}`);
    }
    const bodyLines = parsed.body.split(/\r?\n/).length;
    if (bodyLines > BODY_LINES_SOFT_CAP) {
      warnings.push(
        `skill at ${mdPath}: body ${bodyLines} lines exceeds soft cap ${BODY_LINES_SOFT_CAP} (spec recommends <500 lines / <5000 tokens — split into references/)`,
      );
    }

    const version = typeof fmVersion === "string" ? fmVersion : undefined;
    const allowed_tools = readAllowedTools(fm, mdPath, warnings);
    const license = typeof fm["license"] === "string" ? fm["license"] : undefined;
    const compatibility = readCompatibility(fm, mdPath, warnings);
    const metadata = readMetadata(fm["metadata"]);

    skills.push({
      name,
      description,
      ...(version !== undefined ? { version } : {}),
      ...(allowed_tools !== undefined ? { allowed_tools } : {}),
      ...(license !== undefined ? { license } : {}),
      ...(compatibility !== undefined ? { compatibility } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
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

/** Spec field is `allowed-tools` (kebab) holding a space-separated string;
 * we also accept the snake-cased `allowed_tools` and an array form for
 * cross-client compat. Both keys present → prefer the spec-canonical key
 * and warn. */
function readAllowedTools(fm: Record<string, unknown>, mdPath: string, warnings: string[]): string[] | undefined {
  const kebab = fm["allowed-tools"];
  const snake = fm["allowed_tools"];
  if (kebab !== undefined && snake !== undefined) {
    warnings.push(`skill at ${mdPath}: both "allowed-tools" and "allowed_tools" set — using "allowed-tools" (spec)`);
  }
  const raw = kebab !== undefined ? kebab : snake;
  if (raw === undefined) return undefined;
  if (typeof raw === "string") {
    const parts = raw.split(/\s+/).filter((s) => s.length > 0);
    return parts.length > 0 ? parts : undefined;
  }
  if (Array.isArray(raw)) {
    const parts = raw.filter((t): t is string => typeof t === "string");
    return parts.length > 0 ? parts : undefined;
  }
  return undefined;
}

function readCompatibility(fm: Record<string, unknown>, mdPath: string, warnings: string[]): string | undefined {
  const v = fm["compatibility"];
  if (typeof v !== "string") return undefined;
  if (v.length > COMPATIBILITY_MAX) {
    warnings.push(`skill at ${mdPath}: compatibility ${v.length} chars exceeds ${COMPATIBILITY_MAX}`);
  }
  return v;
}

/** Coerce arbitrary YAML-decoded values into a flat string→string map.
 * Spec calls for "a map from string keys to string values"; numbers and
 * booleans get stringified so authors who write `version: 1.0` aren't
 * silently dropped. */
function readMetadata(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sha256Hex(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}
