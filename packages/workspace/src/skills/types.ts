// Public types for the skill system. See docs/skills.md for the authoring
// guide and the agentskills.io spec for the on-disk contract:
// https://agentskills.io/client-implementation/adding-skills-support

export type SkillScope = "project" | "user";

/** One discovered skill. The body is read on demand by the load_skill tool —
 * discovery only stores metadata + a sha256 of the raw SKILL.md, mirroring
 * how `context_files` captures per-file records. */
export interface Skill {
  /** From frontmatter. Must match the parent directory name (warned, not
   * enforced). Used as the catalog key and the load_skill enum value. */
  name: string;
  /** One-line description shown in the tier-1 catalog. Required. */
  description: string;
  /** Optional frontmatter fields. */
  version?: string;
  allowed_tools?: string[];
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
  /** Scope where the skill was discovered. Project beats user on collisions. */
  scope: SkillScope;
  /** The well-known path the skill came from (absolute), e.g.
   * "/Users/x/.agents/skills". Useful for UI "source" columns. */
  source_dir: string;
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
   * that keeps the skill visible in /skills, use `trust_project: false`
   * on project-scope skills instead. */
  disabled?: string[];
  /** Trust gate for project-scope skills. Default true — swarm agents
   * already have full FS access on the same repo, so gating discovery
   * adds friction without a real security delta. Flip to false in
   * untrusted clones where project-scope skills should be hidden until
   * reviewed. */
  trust_project?: boolean;
}

export interface DiscoverOptions {
  /** Working directory (project root). Used for `<cwd>/.swarm/skills/` etc. */
  cwd: string;
  /** User home directory. Used for `~/.agents/skills/` etc. Pass empty
   * string to skip user-scope discovery. */
  homeDir: string;
  /** Merged skills config from `.swarm/config.yaml`. */
  config?: SkillsConfig;
}

export interface ParsedSkillMd {
  frontmatter: Record<string, unknown>;
  /** Body with frontmatter stripped and leading/trailing whitespace trimmed. */
  body: string;
  /** Non-fatal diagnostics from the lenient parser. */
  warnings: string[];
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
}
