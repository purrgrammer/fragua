// User-preference config for swarm. Two-layer cascade:
//   global   ~/.swarm/config.jsonc   — generic preferences (LLM defaults,
//                                       autoTitle, blocklist, concurrency,
//                                       timeouts, blob GC, skills paths, …)
//   project  <cwd>/.swarm/config.jsonc — project-specific knobs only
//                                       (today: `bootstrap`). Overlays
//                                       global; project keys win.
//
// Top-level keys merge shallowly between the two layers. Nested objects
// (`defaults`, `blobGc`, `skills`, `timeouts`) merge one level deep so a
// project config can override `defaults.llm_model` without losing the
// global `defaults.summariser` block.
//
// Missing files → `{}` (first-run UX). Malformed file or schema-invalid
// content → throw with a caller-friendly message; silent fallback would
// hide typos that would otherwise mis-route runs.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parseDurationMs } from "@swarm/core";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";

const TimeoutValue = Type.Union([Type.String(), Type.Integer({ minimum: 0 })]);

const Summariser = Type.Object(
  {
    llm_provider: Type.Optional(Type.String()),
    llm_model: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const Defaults = Type.Object(
  {
    llm_provider: Type.Optional(Type.String()),
    llm_model: Type.Optional(Type.String()),
    permissions: Type.Optional(Type.String()),
    summariser: Type.Optional(Summariser),
  },
  { additionalProperties: false },
);

const BlobGc = Type.Object(
  {
    interval: Type.Optional(TimeoutValue),
    maxRows: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const Skills = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String())),
    disabled: Type.Optional(Type.Array(Type.String())),
    trustProject: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const Timeouts = Type.Object(
  {
    codergen: Type.Optional(TimeoutValue),
    tool: Type.Optional(TimeoutValue),
    bootstrap: Type.Optional(TimeoutValue),
    shell: Type.Optional(TimeoutValue),
    http: Type.Optional(TimeoutValue),
    leakGrace: Type.Optional(TimeoutValue),
    shutdownDrain: Type.Optional(TimeoutValue),
  },
  { additionalProperties: false },
);

export const SwarmConfigSchema = Type.Object(
  {
    // Schema version. Currently always 1; bumped when the on-disk shape
    // changes in a way readers must opt into.
    version: Type.Optional(Type.Literal(1)),
    // Shell command run inside each fresh worktree before the first node
    // fires. Use whatever the project's stack needs — `bun install
    // --frozen-lockfile`, `pnpm install`, `pip install -r requirements.txt`,
    // `./scripts/bootstrap.sh`, etc. Omit for source-only projects.
    // Non-zero exit fails the run. Project-specific by nature; lives in
    // `<project>/.swarm/config.jsonc`, not the global config.
    bootstrap: Type.Optional(Type.String()),
    defaults: Type.Optional(Defaults),
    // Auto-generated run titles from $ARGUMENTS. true (default) kicks off
    // a fire-and-forget summariser call at run start. false disables.
    // CLI flag --no-auto-title wins over this.
    autoTitle: Type.Optional(Type.Boolean()),
    // Command blocklist applied even in unsafe mode. Matched as literal
    // substrings against the shell command.
    blocklist: Type.Optional(Type.Array(Type.String())),
    // Max concurrent runs the daemon will claim from its queue. CLI
    // `--concurrency` overrides this. Default 8 when unset.
    concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
    // Per-run ceiling on handler dispatches. A workflow that loops
    // indefinitely halts with `reason: "max_loops"`. Default 1000.
    maxLoops: Type.Optional(Type.Integer({ minimum: 1 })),
    // Backpressure cap on `status='queued'` runs. POST /runs returns 429
    // when queue depth reaches this. Absent = uncapped.
    maxQueuedRuns: Type.Optional(Type.Integer({ minimum: 1 })),
    // Max consecutive handler aborts on the same node before halt with
    // `reason: "abort_loop"`. Default 5.
    abortLoopCeiling: Type.Optional(Type.Integer({ minimum: 1 })),
    // Cap on per-process leaked handlers (handler ignored AbortSignal
    // past `maxMs + leakGrace`). Daemon shuts down when crossed.
    // Default 3.
    maxLeakedHandlers: Type.Optional(Type.Integer({ minimum: 1 })),
    blobGc: Type.Optional(BlobGc),
    skills: Type.Optional(Skills),
    timeouts: Type.Optional(Timeouts),
  },
  { additionalProperties: false },
);

export type SwarmConfig = Static<typeof SwarmConfigSchema>;

/** Every timeout key, resolved to milliseconds. Absent keys stay
 * `undefined` so callers fall through to handler defaults. */
export interface ResolvedTimeouts {
  codergen?: number;
  tool?: number;
  bootstrap?: number;
  shell?: number;
  http?: number;
  leakGrace?: number;
  shutdownDrain?: number;
}

/** Parse and validate each present key in `cfg.timeouts`. Throws a
 * caller-friendly Error on the first invalid value so the daemon
 * startup path can surface the name + reason without a stack-trace. */
export function resolveTimeouts(cfg: SwarmConfig): ResolvedTimeouts {
  const out: ResolvedTimeouts = {};
  if (cfg.timeouts == null) return out;
  const keys = ["codergen", "tool", "bootstrap", "shell", "http", "leakGrace", "shutdownDrain"] as const;
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

function formatParseErrors(errors: ParseError[]): string {
  return errors
    .slice(0, 3)
    .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
    .join("; ");
}

function formatValidationErrors(errors: Iterable<{ path: string; message: string }>): string {
  const list = [...errors].slice(0, 3);
  return list.map((e) => `${e.path || "<root>"}: ${e.message}`).join("; ");
}

/** Parse and validate one config file. Returns `{}` if the file is
 * missing. Throws on parse or schema errors so typos surface
 * immediately. */
async function loadConfigFile(path: string): Promise<SwarmConfig> {
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch {
    return {};
  }
  const errors: ParseError[] = [];
  const parsed = parse(body, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new Error(`config: parse error in ${path}: ${formatParseErrors(errors)}`);
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`config: ${path} must be a JSON object`);
  }
  if (!Value.Check(SwarmConfigSchema, parsed)) {
    const msg = formatValidationErrors(Value.Errors(SwarmConfigSchema, parsed));
    throw new Error(`config: validation failed in ${path}: ${msg}`);
  }
  return parsed;
}

/** One-level deep merge: top-level scalars from `overlay` win; nested
 * objects merge field-by-field. Arrays replace wholesale. */
function mergeConfig(base: SwarmConfig, overlay: SwarmConfig): SwarmConfig {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;
    const existing = (base as Record<string, unknown>)[key];
    const isPlainObject = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v);
    if (isPlainObject(value) && isPlainObject(existing)) {
      out[key] = { ...existing, ...value };
    } else {
      out[key] = value;
    }
  }
  return out as SwarmConfig;
}

/** Load the merged user config: `~/.swarm/config.jsonc` (global) overlaid
 * by `<cwd>/.swarm/config.jsonc` (project). Either layer may be absent.
 * Project keys win on collisions; nested objects merge one level deep.
 *
 * `opts.homeDir` overrides the global path's base — used by tests to
 * isolate from the user's real `~/.swarm/`. Production callers omit it. */
export async function loadConfig(cwd: string, opts: { homeDir?: string } = {}): Promise<SwarmConfig> {
  const globalPath = resolve(opts.homeDir ?? homedir(), ".swarm/config.jsonc");
  const projectPath = resolve(cwd, ".swarm/config.jsonc");
  const [global, project] = await Promise.all([loadConfigFile(globalPath), loadConfigFile(projectPath)]);
  return mergeConfig(global, project);
}
