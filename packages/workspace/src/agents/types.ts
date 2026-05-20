// Agent-definition shape lives in @swarm/types so non-workspace packages
// (daemon, agent backend, future web UI) can reference it without
// pulling the workspace runtime in. Re-exported here so existing
// `import { AgentDefinition } from "@swarm/workspace"` callers compile.

export type { AgentDefinition, AgentDefinitionScope, AgentDefinitionsConfig } from "@swarm/types";

export interface DiscoverAgentsOptions {
  /** Project cwds to scan. Each yields project-scope records stamped
   *  with `project_cwd`. Pass `[]` for user-scope-only discovery.
   *  Mirrors the skills shape — see `skills/types.ts`. */
  projectCwds: readonly string[];
  /** User home directory. Used for `~/.agents/agents/` and
   *  `~/.claude/agents/`. Pass empty string to skip user-scope
   *  discovery. */
  homeDir: string;
  /** Merged config from `.swarm/config.yaml`. Treated as global. */
  config?: import("@swarm/types").AgentDefinitionsConfig;
}

export interface ParsedAgentMd {
  frontmatter: Record<string, unknown>;
  /** Body with frontmatter stripped and leading/trailing whitespace
   *  trimmed. Becomes the sub-agent's system prompt verbatim when
   *  promoted. */
  body: string;
  /** Non-fatal diagnostics from the lenient parser. */
  warnings: string[];
}
