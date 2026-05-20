// Skill metadata types. Runtime discovery + parsing live in @swarm/workspace
// (which depends on node:fs); only the static shapes are exported here so
// downstream packages — web UI, server endpoints, future store rows —
// can reference skill records without pulling in the workspace layer.

export type SkillScope = "project" | "user";

/** One discovered skill. The body is read on demand by the agent —
 * discovery only stores metadata + a sha256 of the raw SKILL.md, mirroring
 * how `context_files` captures per-file records. */
export interface Skill {
  /** From frontmatter. Spec requires lowercase a-z, 0-9, hyphens; max 64
   * chars; matching the parent directory name. Enforced as warnings, not
   * skips, so cross-client skills load even if they bend the rules. */
  name: string;
  /** One-line description shown in the tier-1 catalog. Required. Spec cap
   * is 1024 chars (warned, not enforced). */
  description: string;
  /** Optional frontmatter fields. */
  version?: string;
  /** Spec field name is `allowed-tools` (kebab) holding a space-separated
   * string; the snake-cased `allowed_tools` is also accepted for
   * back-compat. Value is normalized to an array regardless of source
   * shape. (Experimental in spec — agent enforcement varies.) */
  allowed_tools?: string[];
  /** Optional license name or reference to a bundled license file. */
  license?: string;
  /** Optional environment requirements ("Requires Python 3.14+", "Designed
   * for Claude Code"). Surfaced in the tier-1 catalog when present so the
   * model can factor it in before activating the skill. Spec cap 500. */
  compatibility?: string;
  /** Optional client-defined metadata. Stored verbatim; not surfaced to
   * the model. Useful for UI columns and cross-client extensions. */
  metadata?: Record<string, string>;
  /** Absolute path to SKILL.md. */
  location: string;
  /** Absolute path to the skill directory (parent of SKILL.md). Used to
   * resolve relative paths referenced in the body (scripts/, references/)
   * and to allowlist the directory when reading resources. */
  skill_dir: string;
  /** sha256 of SKILL.md raw bytes (pre-trim). Lets replay detect drift. */
  sha256: string;
  /** Byte length of SKILL.md raw bytes. */
  bytes: number;
  /** Scope where the skill was discovered. Project beats user on collisions
   * (resolved at llm-time per-run, not at discovery — see `project_cwd`). */
  scope: SkillScope;
  /** The well-known path the skill came from (absolute), e.g.
   * "/Users/x/.agents/skills". Useful for UI "source" columns. */
  source_dir: string;
  /** Project cwd this record is anchored to. Set only when `scope === "project"`.
   * Discovery walks every known project cwd and emits a superset; the
   * llm-time filter prunes to `scope === "user" || project_cwd === run.cwd`.
   * Two projects can both legitimately ship a skill named `frontend` — they
   * coexist in the superset, distinguished by this field. */
  project_cwd?: string;
  /** When set, the skill was discovered but should not appear in the
   * tier-1 catalog / enum. Surfaced via GET /skills so the UI can show
   * it greyed-out with an explanation. */
  disabled_reason?: string;
}

/** User-provided config. Absent / empty enables auto-discovery. */
export interface SkillsConfig {
  /** Explicit directories to scan. When set, auto-discovery of well-known
   * paths is disabled. Each entry is a directory containing
   * `<skill-name>/SKILL.md` subdirectories (NOT a glob of SKILL.md). */
  paths?: string[];
  /** Names to exclude from discovery entirely. Skills listed here are
   * dropped before the precedence merge — they do not appear in the
   * agent catalog, on GET /skills, or in the web UI. Use this when you
   * want to pretend a skill isn't installed. For temporary soft-hiding
   * that keeps the skill visible in /skills, use `"trust-project": false`
   * on project-scope skills instead. */
  disabled?: string[];
  /** Trust gate for project-scope skills. Default true — swarm agents
   * already have full FS access on the same repo, so gating discovery
   * adds friction without a real security delta. Flip to false in
   * untrusted clones where project-scope skills should be hidden until
   * reviewed. */
  "trust-project"?: boolean;
}

/** Durable per-skill record emitted on `llm.start.skills[]`. Compact
 * subset of `Skill` — we drop fields the replay harness can re-derive
 * (skill_dir, allowed_tools, etc.) to keep the event log lean. */
export interface SkillCatalogRecord {
  name: string;
  location: string;
  sha256: string;
  bytes: number;
  scope: SkillScope;
  source_dir: string;
  /** Project cwd this record is anchored to. Set only when `scope === "project"`.
   * Captured so replay can correlate per-run filtering decisions against
   * which project's skills the run actually saw. */
  project_cwd?: string;
  /** Captured when set so replay can correlate environment-mismatch
   * outcomes against advertised compatibility constraints. */
  compatibility?: string;
}
