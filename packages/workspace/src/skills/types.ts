// Skill metadata types live in @swarm/types so non-workspace packages
// (web UI, server, future store rows) can reference them without
// pulling the workspace runtime in. Re-exported here so existing
// `import { Skill } from "@swarm/workspace"` callers still compile.

export type { Skill, SkillCatalogRecord, SkillScope, SkillsConfig } from "@swarm/types";

export interface DiscoverOptions {
  /** Working directory (project root). Used for `<cwd>/.agents/skills/` etc. */
  cwd: string;
  /** User home directory. Used for `~/.agents/skills/` etc. Pass empty
   * string to skip user-scope discovery. */
  homeDir: string;
  /** Merged skills config from `.swarm/config.jsonc`. */
  config?: import("@swarm/types").SkillsConfig;
}

export interface ParsedSkillMd {
  frontmatter: Record<string, unknown>;
  /** Body with frontmatter stripped and leading/trailing whitespace trimmed. */
  body: string;
  /** Non-fatal diagnostics from the lenient parser. */
  warnings: string[];
}
