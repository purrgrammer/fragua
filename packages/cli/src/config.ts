// Load `.swarm/config.yaml` from the project root. Missing / malformed →
// empty config (no errors). The file is a *user preference* layer:
// CLI flags beat config, config beats hard-coded defaults.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";

export interface SwarmConfig {
  project?: {
    name?: string;
    runs_dir?: string;
    /** Shell command run inside each fresh worktree before the first node
     * fires. Use whatever the project's stack needs — `bun install
     * --frozen-lockfile`, `pnpm install`, `pip install -r requirements.txt`,
     * `./scripts/bootstrap.sh`, etc. Omit for source-only projects that
     * don't need a per-worktree install. Non-zero exit fails the run. */
    bootstrap?: string;
  };
  defaults?: {
    provider?: string;
    model?: string;
    permissions?: string;
    /** Small-model summariser config (Wave 2b). Powers auto-title +
     * fidelity=summary:medium/high. Leave unset to disable summarisation
     * (runs proceed, but summary:* fidelities fall back to the
     * deterministic template). Per-provider defaults are used when
     * `model` is unset — see `defaultSummariserModel` in @swarm/agent. */
    summariser?: {
      provider?: string;
      model?: string;
    };
  };
  /** Policy for auto-generated run titles. Omit or set `"on"` to
   * enable (default); `"off"` disables regardless of CLI flag. */
  auto_title?: "on" | "off";
  blocklist?: string[];
  workflows?: Record<string, string>;
  /** Max concurrent run runs the daemon will claim from its queue.
   * CLI `--concurrency` overrides this. Default 8 when unset. */
  concurrency?: number;
  /** Skill discovery knobs. Absent / empty enables auto-discovery of the
   * well-known paths (`.agents/skills`, `.claude/skills`
   * under both project and user scopes). See `packages/workspace/src/skills`
   * and docs/skills.md. */
  skills?: {
    /** Explicit directory list. When set, auto-discovery is disabled and
     * only these directories are scanned (each expected to contain
     * `<skill-name>/SKILL.md` subdirs). */
    paths?: string[];
    /** Names to hide from the tier-1 catalog. Still discovered so the UI
     * can list them as disabled. */
    disabled?: string[];
    /** Trust gate for project-scope skills. Default true. */
    trust_project?: boolean;
  };
}

/** Load and parse `<cwd>/.swarm/config.yaml`. Returns `{}` if the file is
 * missing or unparseable — config is always optional. */
export async function loadConfig(cwd: string): Promise<SwarmConfig> {
  const path = resolve(cwd, ".swarm/config.yaml");
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = YAML.parse(body);
    return (parsed && typeof parsed === "object" ? parsed : {}) as SwarmConfig;
  } catch {
    return {};
  }
}
