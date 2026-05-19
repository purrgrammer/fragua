// Skill metadata types live in @swarm/types so non-workspace packages
// (web UI, server, future store rows) can reference them without
// pulling the workspace runtime in. Re-exported here so existing
// `import { Skill } from "@swarm/workspace"` callers still compile.

export type { Skill, SkillCatalogRecord, SkillScope, SkillsConfig } from "@swarm/types";

export interface DiscoverOptions {
  /** Project cwds to scan. Each yields project-scope records stamped
   * with `project_cwd`. Pass `[]` for user-scope-only discovery.
   * Discovery emits a superset across every cwd; the llm-time
   * filter prunes to a single project per run. */
  projectCwds: readonly string[];
  /** User home directory. Used for `~/.agents/skills/` etc. Pass empty
   * string to skip user-scope discovery. */
  homeDir: string;
  /** Merged skills config from `.swarm/config.jsonc`. Treated as global
   * across all `projectCwds` — per-project config reading is a separate
   * concern (see proposals/skills-and-agents-ui.md). */
  config?: import("@swarm/types").SkillsConfig;
}

export interface ParsedSkillMd {
  frontmatter: Record<string, unknown>;
  /** Body with frontmatter stripped and leading/trailing whitespace trimmed. */
  body: string;
  /** Non-fatal diagnostics from the lenient parser. */
  warnings: string[];
}
