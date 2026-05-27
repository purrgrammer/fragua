// User-preference config for fragua. Two-layer cascade:
//   global   ~/.fragua/config.yaml   — generic preferences (LLM defaults,
//                                      auto-title, blocklist, concurrency,
//                                      timeouts, blob GC, skills paths, …)
//   project  <cwd>/.fragua/config.yaml — project-specific knobs only
//                                      (today: `bootstrap`). Overlays
//                                      global; project keys win.
//
// Top-level keys merge shallowly between the two layers. Nested objects
// (`defaults`, `blob-gc`, `skills`, `timeouts`, `summariser`) merge one level
// deep so a project config can override `defaults.model` without losing
// the global `summariser` block.
//
// Missing files → `{}` (first-run UX). Malformed file or schema-invalid
// content → throw with a caller-friendly message; silent fallback would
// hide typos that would otherwise mis-route runs.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseDurationMs } from "@fragua/core";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import YAML from "yaml";

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
  },
  { additionalProperties: false },
);

const BlobGc = Type.Object(
  {
    interval: Type.Optional(TimeoutValue),
    "max-rows": Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const Skills = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String())),
    disabled: Type.Optional(Type.Array(Type.String())),
    "trust-project": Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const Timeouts = Type.Object(
  {
    llm: Type.Optional(TimeoutValue),
    tool: Type.Optional(TimeoutValue),
    bootstrap: Type.Optional(TimeoutValue),
    shell: Type.Optional(TimeoutValue),
    http: Type.Optional(TimeoutValue),
    "leak-grace": Type.Optional(TimeoutValue),
    "shutdown-drain": Type.Optional(TimeoutValue),
  },
  { additionalProperties: false },
);

const Web = Type.Object(
  {
    // Default TCP port for the harness / serve HTTP. CLI `--port` wins
    // when supplied; absent here falls through to DEFAULT_WEB_PORT
    // (6767). When the resolved port is in use, the server bumps to the
    // next free port so a stray collision doesn't kill startup.
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  },
  { additionalProperties: false },
);

export const FraguaConfigSchema = Type.Object(
  {
    // UUIDv7 stable project identity, minted by `fragua init`. Optional
    // here so hand-rolled configs (e.g. `fragua init` predates the field)
    // don't fail validation. Routing keys on the daemon's internal
    // project mapping, not this; treat `id` as advisory metadata.
    id: Type.Optional(Type.String()),
    // Display name for the project — surfaced in UI listings and the
    // run dashboard. Optional and advisory.
    name: Type.Optional(Type.String()),
    // Shell command run inside each fresh worktree before the first node
    // fires. Use whatever the project's stack needs — `bun install
    // --frozen-lockfile`, `pnpm install`, `pip install -r requirements.txt`,
    // `./scripts/bootstrap.sh`, etc. Omit for source-only projects.
    // Non-zero exit fails the run. Project-specific by nature; lives in
    // `<project>/.fragua/config.yaml`, not the global config.
    bootstrap: Type.Optional(Type.String()),
    // Per-bootstrap timeout in milliseconds. Pairs with `bootstrap` —
    // ergonomically grouped at top level so a project that pins both
    // doesn't have to split across `bootstrap` + `timeouts.bootstrap`.
    // When both this and `timeouts.bootstrap` are set, this top-level
    // value wins (it's more explicit about belonging to bootstrap).
    // `timeouts.bootstrap` stays supported and accepts duration strings
    // like `"10m"` — use that form when you'd rather express "10 minutes"
    // than "600000".
    "bootstrap-timeout-ms": Type.Optional(Type.Integer({ minimum: 0 })),
    defaults: Type.Optional(Defaults),
    // Weak-model summariser. Powers async run-title generation (auto-title)
    // and per-node `summary=low|medium|high` transcript compression. Always
    // cheaper than the primary coding model. Omit to disable both paths.
    summariser: Type.Optional(Summariser),
    // Auto-generated run titles from the run's typed inputs + workflow name.
    // true (default) kicks off
    // a fire-and-forget summariser call at run start. false disables.
    // CLI flag --no-auto-title wins over this.
    "auto-title": Type.Optional(Type.Boolean()),
    // Command blocklist applied even in unsafe mode. Matched as literal
    // substrings against the shell command.
    blocklist: Type.Optional(Type.Array(Type.String())),
    // Max concurrent runs the daemon will claim from its queue. CLI
    // `--concurrency` overrides this. Default 16 when unset.
    concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
    // Per-run ceiling on handler dispatches. A workflow that loops
    // indefinitely halts with `reason: "max_loops"`. Default 1000.
    "max-loops": Type.Optional(Type.Integer({ minimum: 1 })),
    // Backpressure cap on `status='queued'` runs. POST /runs returns 429
    // when queue depth reaches this. Absent = uncapped.
    "max-queued-runs": Type.Optional(Type.Integer({ minimum: 1 })),
    // Max consecutive handler aborts on the same node before halt with
    // `reason: "abort_loop"`. Default 5.
    "abort-loop-ceiling": Type.Optional(Type.Integer({ minimum: 1 })),
    // Cap on per-process leaked handlers (handler ignored AbortSignal
    // past `maxMs + leak-grace`). Daemon shuts down when crossed.
    // Default 3.
    "max-leaked-handlers": Type.Optional(Type.Integer({ minimum: 1 })),
    "blob-gc": Type.Optional(BlobGc),
    skills: Type.Optional(Skills),
    timeouts: Type.Optional(Timeouts),
    web: Type.Optional(Web),
  },
  { additionalProperties: false },
);

export type FraguaConfig = Static<typeof FraguaConfigSchema>;

/** Every timeout key, resolved to milliseconds. Absent keys stay
 * `undefined` so callers fall through to handler defaults. */
export interface ResolvedTimeouts {
  llm?: number;
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
export function resolveTimeouts(cfg: FraguaConfig): ResolvedTimeouts {
  const out: ResolvedTimeouts = {};
  if (cfg.timeouts == null) return out;
  // Single-word keys map to themselves in ResolvedTimeouts; hyphenated
  // source keys map to their camelCase output counterparts.
  const single = ["llm", "tool", "bootstrap", "shell", "http"] as const;
  for (const key of single) {
    const raw = cfg.timeouts[key];
    if (raw == null) continue;
    try {
      out[key] = parseDurationMs(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`config: timeouts.${key}: ${msg}`);
    }
  }
  const hyphenated = [
    ["leak-grace", "leakGrace"],
    ["shutdown-drain", "shutdownDrain"],
  ] as const;
  for (const [srcKey, outKey] of hyphenated) {
    const raw = cfg.timeouts[srcKey];
    if (raw == null) continue;
    try {
      out[outKey] = parseDurationMs(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`config: timeouts.${srcKey}: ${msg}`);
    }
  }
  return out;
}

function formatValidationErrors(errors: Iterable<{ path: string; message: string }>): string {
  const list = [...errors].slice(0, 3);
  return list.map((e) => `${e.path || "<root>"}: ${e.message}`).join("; ");
}

/** Parse a YAML body. Returns the parsed object, or null on parse
 * failure (caller will warn and return {}). */
function parseYamlBody(body: string, filePath: string): unknown | null {
  try {
    // An empty or comments-only document parses to null — treat it as an
    // empty config object (a project may ship only commented-out knobs).
    return YAML.parse(body) ?? {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`config: parse error in ${filePath}: ${msg} — ignoring file, using defaults`);
    return null;
  }
}

/** Validate the parsed value against FraguaConfigSchema.
 * Non-fatal: unknown/extra properties are stripped with a warning;
 * wrong-typed top-level values are dropped with a warning.
 * Returns the salvaged (schema-valid) config, or {} when the root
 * is not an object at all. */
function validateParsed(parsed: unknown, filePath: string): FraguaConfig {
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(`config: ${filePath} must be a JSON object — ignoring file, using defaults`);
    return {};
  }
  if (Value.Check(FraguaConfigSchema, parsed)) {
    return parsed;
  }
  // Capture errors before mutating.
  const errors = [...Value.Errors(FraguaConfigSchema, parsed)];
  const msg = formatValidationErrors(errors);
  console.warn(`config: validation issues in ${filePath}: ${msg} — unknown/invalid keys will be ignored`);
  // Step 1: strip unknown properties at all nesting levels.
  const cleaned = Value.Clean(FraguaConfigSchema, structuredClone(parsed)) as Record<string, unknown>;
  // Step 2: drop any top-level key that still has a type error after cleaning.
  for (const err of Value.Errors(FraguaConfigSchema, cleaned)) {
    const topKey = err.path.split("/").filter(Boolean)[0];
    if (topKey !== undefined) delete cleaned[topKey];
  }
  return cleaned as FraguaConfig;
}

/** Parse and validate one config layer's `<dir>/.fragua/config.yaml`.
 * Returns `{}` when the file is absent. */
async function loadConfigFile(layerDir: string): Promise<FraguaConfig> {
  const yamlPath = resolve(layerDir, ".fragua/config.yaml");

  let yamlBody: string;
  try {
    yamlBody = await readFile(yamlPath, "utf8");
  } catch {
    return {};
  }

  const parsed = parseYamlBody(yamlBody, yamlPath);
  return parsed === null ? {} : validateParsed(parsed, yamlPath);
}

/** One-level deep merge: top-level scalars from `overlay` win; nested
 * objects merge field-by-field. Arrays replace wholesale. */
function mergeConfig(base: FraguaConfig, overlay: FraguaConfig): FraguaConfig {
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
  return out as FraguaConfig;
}

/** Load the merged user config: `~/.fragua/config.yaml` (global) overlaid
 * by `<cwd>/.fragua/config.yaml` (project). Either layer may be absent.
 * Project keys win on collisions; nested objects merge one level deep.
 *
 * `opts.homeDir` overrides the global path's base — used by tests to
 * isolate from the user's real `~/.fragua/`. Production callers omit it. */
export async function loadConfig(cwd: string, opts: { homeDir?: string } = {}): Promise<FraguaConfig> {
  const globalDir = opts.homeDir ?? homedir();
  const [global, project] = await Promise.all([loadConfigFile(globalDir), loadConfigFile(cwd)]);
  return mergeConfig(global, project);
}

/** Load *only* `<cwd>/.fragua/config.yaml` — no global cascade. Used
 * for keys that must be strictly project-scoped (e.g. `bootstrap`,
 * which is per-project tooling and would silently leak between
 * projects if the global layer was allowed to supply a default).
 * Returns `{}` when the project file is absent. */
export async function loadProjectConfig(cwd: string): Promise<FraguaConfig> {
  return loadConfigFile(cwd);
}

/** Per-worktree bootstrap pair resolved from `<cwd>/.fragua/config.yaml`. */
export interface ResolvedBootstrap {
  bootstrap?: string;
  bootstrapTimeoutMs?: number;
}

/** Resolve a project's per-worktree bootstrap command + timeout from its
 * project-scoped config (no global cascade — bootstrap is per-project tooling).
 * Top-level `bootstrap-timeout-ms` wins over nested `timeouts.bootstrap` when
 * both are set. Shared by the daemon provisioner (`resolveRunBootstrap`) and
 * `runs import --rehydrate`, so a rehydrated worktree bootstraps from the same
 * source — and the same logic — a native run does. */
export async function resolveProjectBootstrap(cwd: string): Promise<ResolvedBootstrap> {
  const projectCfg = await loadProjectConfig(cwd);
  const projectTimeouts = resolveTimeouts(projectCfg);
  const out: ResolvedBootstrap = {};
  if (projectCfg.bootstrap !== undefined) out.bootstrap = projectCfg.bootstrap;
  if (projectCfg["bootstrap-timeout-ms"] !== undefined) {
    out.bootstrapTimeoutMs = projectCfg["bootstrap-timeout-ms"];
  } else if (projectTimeouts.bootstrap !== undefined) {
    out.bootstrapTimeoutMs = projectTimeouts.bootstrap;
  }
  return out;
}
