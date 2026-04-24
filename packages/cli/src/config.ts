// Load `.swarm/config.yaml` from the project root. Missing / malformed →
// empty config (no errors). The file is a *user preference* layer:
// CLI flags beat config, config beats hard-coded defaults.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDurationMs } from "@swarm/core";
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
    /** Small-model summariser config. Powers auto-title and
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
  /** Max concurrent runs the daemon will claim from its queue.
   * CLI `--concurrency` overrides this. Default 8 when unset. */
  concurrency?: number;
  /** Per-run ceiling on handler dispatches. A workflow that loops
   * indefinitely without aborting halts with `reason: "max_loops"` once
   * this many dispatches have run on the same run. Absent = executor
   * default (1000). Raise it for long-running HITL workflows that
   * legitimately iterate through many nodes across many human turns. */
  max_loops?: number;
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
  /** Global per-kind timeout defaults. Each value accepts a duration
   * string ("30s", "5m", "2h") or a raw millisecond integer. Per-node
   * DOT `timeout=`/`maxMs=` attrs override these; handler built-in
   * defaults apply when a kind is absent. Invalid values fail daemon
   * startup loudly — silent fall-through would make runtime behavior
   * silently diverge from authored intent. */
  timeouts?: {
    codergen?: string | number;
    tool?: string | number;
    bootstrap?: string | number;
    shell?: string | number;
    http?: string | number;
    leak_grace?: string | number;
    shutdown_drain?: string | number;
  };
}

/** Every timeout key in `SwarmConfig.timeouts`, resolved to milliseconds.
 * Populated by {@link resolveTimeouts}. Absent keys stay `undefined`
 * so callers know to fall through to handler defaults. */
export interface ResolvedTimeouts {
  codergen?: number;
  tool?: number;
  bootstrap?: number;
  shell?: number;
  http?: number;
  leak_grace?: number;
  shutdown_drain?: number;
}

/** Parse and validate each present key in `cfg.timeouts`. Throws a
 * caller-friendly Error on the first invalid value so the daemon
 * startup path can surface the name + reason without a stack-trace
 * dump. */
export function resolveTimeouts(cfg: SwarmConfig): ResolvedTimeouts {
  const out: ResolvedTimeouts = {};
  if (cfg.timeouts == null) return out;
  const keys = ["codergen", "tool", "bootstrap", "shell", "http", "leak_grace", "shutdown_drain"] as const;
  for (const key of keys) {
    const raw = cfg.timeouts[key];
    if (raw == null) continue;
    try {
      out[key] = parseDurationMs(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`config: timeouts.${key}: ${msg}`);
    }
  }
  return out;
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
