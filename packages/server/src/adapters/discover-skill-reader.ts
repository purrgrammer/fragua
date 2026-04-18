// `SkillReader` adapter that runs `discoverSkills` from `@swarm/workspace`
// against the server's `cwd` + the user's `homeDir`. Caches the list with
// a short TTL so repeated `/skills` requests don't re-scan the filesystem,
// but the cache is bypassed when `list({ refresh: true })` is called
// (wired up to the `?refresh=1` query param on the route).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { discoverSkills, type Skill, type SkillsConfig, stripFrontmatter } from "@swarm/workspace";
import type { SkillDetail, SkillReader, SkillSummary } from "../ports.ts";

export interface DiscoverSkillReaderOptions {
  /** Project root scanned for `.agents/skills/`, `.claude/skills/`, etc. */
  cwd: string;
  /** User home — set to "" to skip user-scope discovery (tests usually do this). */
  homeDir?: string;
  /** Merged `skills` block from `.swarm/config.yaml`. */
  config?: SkillsConfig;
  /** Cache TTL for `list()` in ms. Default 60s; set to 0 to disable caching. */
  cacheTtlMs?: number;
}

export function createDiscoverSkillReader(opts: DiscoverSkillReaderOptions): SkillReader {
  const home = opts.homeDir ?? homedir();
  const ttl = opts.cacheTtlMs ?? 60_000;

  let cache: { skills: Skill[]; at: number } | undefined;

  const refresh = async (): Promise<Skill[]> => {
    const result = await discoverSkills({
      cwd: opts.cwd,
      homeDir: home,
      ...(opts.config !== undefined ? { config: opts.config } : {}),
    });
    cache = { skills: result.skills, at: Date.now() };
    return result.skills;
  };

  const getSkills = async (bypassCache: boolean): Promise<Skill[]> => {
    if (bypassCache || !cache || Date.now() - cache.at > ttl) return refresh();
    return cache.skills;
  };

  return {
    async list(listOpts?: { refresh?: boolean }): Promise<SkillSummary[]> {
      const skills = await getSkills(listOpts?.refresh === true);
      return skills.map(toSummary);
    },
    async read(name: string): Promise<SkillDetail | undefined> {
      const skills = await getSkills(false);
      const hit = skills.find((s) => s.name === name);
      if (!hit) return undefined;
      const raw = await readFile(hit.location, "utf8");
      return { ...toSummary(hit), body: stripFrontmatter(raw) };
    },
  };
}

function toSummary(s: Skill): SkillSummary {
  const out: SkillSummary = {
    name: s.name,
    description: s.description,
    location: s.location,
    skill_dir: s.skill_dir,
    sha256: s.sha256,
    bytes: s.bytes,
    scope: s.scope,
    source_dir: s.source_dir,
  };
  if (s.version !== undefined) out.version = s.version;
  if (s.allowed_tools !== undefined) out.allowed_tools = s.allowed_tools;
  if (s.disabled_reason !== undefined) out.disabled_reason = s.disabled_reason;
  return out;
}
