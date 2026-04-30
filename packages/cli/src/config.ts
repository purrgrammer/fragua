// Load `.swarm/config.jsonc` from the project root. The file is the
// project's identity (`id`, `name`) and a *user preference* layer:
// CLI flags beat config, config beats hard-coded defaults.
//
// Missing file → `{}` (first-run UX). Malformed file or schema-invalid
// content → throw with a caller-friendly message; silent fallback would
// hide typos that would otherwise mis-route runs.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parseDurationMs } from "@swarm/core";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";

const TimeoutValue = Type.Union([Type.String(), Type.Integer({ minimum: 0 })]);

const Summariser = Type.Object(
  {
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const Defaults = Type.Object(
  {
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
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
    // Project identity (UUIDv7) — set by `swarm init`, committed to git.
    // Two clones of the same repo see the same id; runs join on it.
    id: Type.Optional(
      Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" }),
    ),
    // Display name. Advisory only — never key on this; rename-safe routing
    // uses `id`.
    name: Type.Optional(Type.String()),
    // Shell command run inside each fresh worktree before the first node
    // fires. Use whatever the project's stack needs — `bun install
    // --frozen-lockfile`, `pnpm install`, `pip install -r requirements.txt`,
    // `./scripts/bootstrap.sh`, etc. Omit for source-only projects.
    // Non-zero exit fails the run.
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

/** Load and parse `<cwd>/.swarm/config.jsonc`. Returns `{}` if the file
 * is missing — config is always optional. Throws on parse or schema
 * errors so typos surface immediately. */
export async function loadConfig(cwd: string): Promise<SwarmConfig> {
  const path = resolve(cwd, ".swarm/config.jsonc");
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
