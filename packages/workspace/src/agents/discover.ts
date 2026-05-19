// Agent-definition discovery. Mirrors `skills/discover.ts`: walks
// `~/.agents`, `~/.claude` and every project cwd in `projectCwds`,
// emitting a superset. Project-scope records carry `project_cwd`; the
// llm-time filter prunes per-run.
//
// Within-bucket precedence: project = `.agents/agents` beats
// `.claude/agents` per cwd; user scope same order. Cross-scope and
// cross-project shadowing happens at llm filter time.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentDefinition, AgentDefinitionScope, AgentDefinitionsConfig } from "@swarm/types";
import { normaliseToolName } from "./normalise.ts";
import { parseAgentMd } from "./parse.ts";
import type { DiscoverAgentsOptions } from "./types.ts";

const PROJECT_WELL_KNOWN = [".agents/agents", ".claude/agents"] as const;
const USER_WELL_KNOWN = [".agents/agents", ".claude/agents"] as const;

export interface DiscoverAgentsResult {
  agents: AgentDefinition[];
  warnings: string[];
}

interface Root {
  path: string;
  scope: AgentDefinitionScope;
  projectCwd?: string;
}

export async function discoverAgents(opts: DiscoverAgentsOptions): Promise<DiscoverAgentsResult> {
  const config: AgentDefinitionsConfig = opts.config ?? {};
  const disabledSet = new Set(config.disabled ?? []);

  const roots = buildRoots(opts);
  const warnings: string[] = [];

  const projectByCwdName = new Map<string, Map<string, AgentDefinition>>();
  const userByName = new Map<string, AgentDefinition>();

  for (const root of roots) {
    const fromRoot = await scanRoot(root.path, root.scope, warnings);
    for (const def of fromRoot) {
      if (disabledSet.has(def.name)) continue;
      if (def.scope === "project") {
        if (root.projectCwd !== undefined) {
          def.project_cwd = root.projectCwd;
        }
        const cwdKey = root.projectCwd ?? "";
        let inner = projectByCwdName.get(cwdKey);
        if (!inner) {
          inner = new Map();
          projectByCwdName.set(cwdKey, inner);
        }
        const existing = inner.get(def.name);
        if (!existing) {
          inner.set(def.name, def);
        } else {
          warnings.push(`agent "${def.name}" at ${def.location} shadowed by ${existing.location}`);
        }
      } else {
        const existing = userByName.get(def.name);
        if (!existing) {
          userByName.set(def.name, def);
        } else {
          warnings.push(`agent "${def.name}" at ${def.location} shadowed by ${existing.location}`);
        }
      }
    }
  }

  const out: AgentDefinition[] = [];
  for (const inner of projectByCwdName.values()) for (const d of inner.values()) out.push(d);
  for (const d of userByName.values()) out.push(d);
  out.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    if (a.scope !== b.scope) return a.scope === "user" ? -1 : 1;
    return (a.project_cwd ?? "").localeCompare(b.project_cwd ?? "");
  });
  return { agents: out, warnings };
}

function buildRoots(opts: DiscoverAgentsOptions): Root[] {
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

const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$/;

async function scanRoot(rootPath: string, scope: AgentDefinitionScope, warnings: string[]): Promise<AgentDefinition[]> {
  let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>;
  try {
    entries = (await readdir(rootPath, { withFileTypes: true })) as unknown as Array<{
      name: string;
      isFile: () => boolean;
      isDirectory: () => boolean;
    }>;
  } catch {
    return []; // missing dir is fine — agent roots are optional
  }

  const out: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) continue;
    if (!entry.name.endsWith(".md")) continue;
    const filePath = resolve(rootPath, entry.name);
    let raw: string;
    let bytes: number;
    try {
      const s = await stat(filePath);
      if (!s.isFile()) continue;
      raw = await readFile(filePath, "utf8");
      bytes = s.size;
    } catch {
      continue;
    }

    const parsed = parseAgentMd(raw);
    for (const w of parsed.warnings) warnings.push(`agent at ${filePath}: ${w}`);
    const fm = parsed.frontmatter;
    const stem = entry.name.slice(0, -".md".length);
    const fmName = fm["name"];
    const fmDesc = fm["description"];

    const name = typeof fmName === "string" ? fmName : "";
    const description = typeof fmDesc === "string" ? fmDesc : "";

    if (!name) {
      warnings.push(`agent at ${filePath}: missing or empty name (skipped)`);
      continue;
    }
    if (!description) {
      warnings.push(`agent at ${filePath}: missing or empty description (skipped)`);
      continue;
    }

    if (name.length > NAME_MAX) {
      warnings.push(`agent at ${filePath}: name "${name}" exceeds ${NAME_MAX} chars`);
    }
    if (!NAME_RE.test(name)) {
      warnings.push(
        `agent at ${filePath}: name "${name}" violates spec charset (lowercase a-z, 0-9, hyphen; no leading/trailing or consecutive hyphens)`,
      );
    }
    if (name !== stem) {
      warnings.push(`agent at ${filePath}: frontmatter name "${name}" does not match filename stem "${stem}"`);
    }
    if (description.length > DESCRIPTION_MAX) {
      warnings.push(`agent at ${filePath}: description ${description.length} chars exceeds ${DESCRIPTION_MAX}`);
    }

    const model = typeof fm["model"] === "string" ? fm["model"] : undefined;
    const provider = typeof fm["provider"] === "string" ? fm["provider"] : undefined;
    const allowed_tools = readAllowedTools(fm);

    out.push({
      name,
      description,
      ...(model !== undefined ? { model } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(allowed_tools !== undefined ? { allowed_tools } : {}),
      body: parsed.body,
      location: filePath,
      sha256: sha256Hex(raw),
      bytes,
      scope,
      source_dir: rootPath,
    });
  }
  return out;
}

/** Accept array form `[read, grep]` or space-separated string `read grep`,
 *  mirroring skills' loose ingestion. Each entry is run through
 *  `normaliseToolName` so cross-client casing (`Read`, `WebFetch`)
 *  resolves to swarm's canonical lowercase snake_case silently. */
function readAllowedTools(fm: Record<string, unknown>): string[] | undefined {
  // `tools:` is the Claude Code convention; AGENTS.md advertises
  // `.claude/agents/` as a cross-client fallback, so accept it as a
  // synonym alongside swarm's canonical `allowed_tools` / `allowed-tools`.
  const raw = fm["allowed_tools"] ?? fm["allowed-tools"] ?? fm["tools"];
  if (raw === undefined) return undefined;
  let parts: string[];
  if (typeof raw === "string") {
    // Accept whitespace OR comma separators so Claude-Code-style
    // `tools: Read, Write, Edit, Bash, Grep` parses correctly.
    parts = raw.split(/[\s,]+/).filter((s) => s.length > 0);
  } else if (Array.isArray(raw)) {
    parts = raw.filter((t): t is string => typeof t === "string");
  } else {
    return undefined;
  }
  if (parts.length === 0) return undefined;
  return parts.map((p) => normaliseToolName(p).name);
}

function sha256Hex(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}
