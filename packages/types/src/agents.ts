// Agent-definition metadata types. Runtime discovery + parsing live in
// @swarm/workspace (which depends on node:fs); only the static shapes are
// exported here so downstream packages — daemon, agent backend, future
// web UI / server endpoints — can reference profile records without
// pulling in the workspace layer.

export type AgentDefinitionScope = "project" | "user";

/** One discovered named sub-agent profile. The body is held in memory
 *  (small markdown bodies, ~kilobytes) and becomes the sub-agent's
 *  system prompt verbatim when no inline `system_prompt` overrides it.
 *  See `docs/proposals/agent-definitions.md`. */
export interface AgentDefinition {
  /** From frontmatter `name`. Lowercase a-z, 0-9, hyphens; max 64 chars;
   *  must match the filename stem. Enforced as warnings, not skips —
   *  except for missing `name` / `description`, which are skipped (the
   *  catalogue can't advertise nameless / undescribed profiles). */
  name: string;
  /** From frontmatter `description`. Required. Max 1024 chars (warned,
   *  not enforced). Used in the parent's catalogue block. */
  description: string;
  /** Optional provider-specific model id. When set, overrides the parent
   *  codergen node's model on spawn. Inherits parent's choice when
   *  omitted. */
  model?: string;
  /** Optional provider name. Inherits parent's choice when omitted. */
  provider?: string;
  /** Optional allowlist for the sub-agent's tool pool. Always stored in
   *  canonical lowercase snake_case (the loader normalises any case it
   *  sees). When set, intersected with the parent's pool minus `agent`
   *  on spawn. */
  allowed_tools?: string[];
  /** The markdown body — this becomes the sub-agent's system prompt
   *  verbatim when no inline override is passed. */
  body: string;
  /** Absolute path to the .md file. */
  location: string;
  /** sha256 of the raw file bytes (pre-trim). Lets replay detect drift. */
  sha256: string;
  /** Byte length of the raw file. */
  bytes: number;
  /** Scope where the profile was discovered. Project beats user on
   *  collisions (resolved at spawn-time per-run, not at discovery — see
   *  `project_cwd`). */
  scope: AgentDefinitionScope;
  /** The well-known directory the profile came from (absolute), e.g.
   *  "/Users/x/.agents/agents". Useful for UI "source" columns. */
  source_dir: string;
  /** Project cwd this record is anchored to. Set only when `scope === "project"`.
   *  Discovery walks every known project cwd and emits a superset; the
   *  codergen-time filter prunes to `scope === "user" || project_cwd === run.cwd`. */
  project_cwd?: string;
  /** When set, the profile was discovered but should not appear in the
   *  parent's catalogue. Reserved for forward-compat (V3 per-node
   *  filtering) — discovery itself sets this only for soft-disable
   *  cases, never on validation warnings. */
  disabled_reason?: string;
}

/** User-provided config. Absent / empty enables auto-discovery against
 *  the four well-known roots. Mirrors `SkillsConfig` for consistency. */
export interface AgentDefinitionsConfig {
  /** Names to exclude from discovery entirely. Profiles listed here are
   *  dropped before the precedence merge — they don't appear in the
   *  catalogue or in lookups. */
  disabled?: string[];
}
