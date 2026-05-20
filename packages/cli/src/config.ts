// User-preference config for swarm. Two-layer cascade:
//   global   ~/.swarm/config.yaml   — generic preferences (LLM defaults,
//                                      autoTitle, blocklist, concurrency,
//                                      timeouts, blob GC, skills paths, …)
//   project  <cwd>/.swarm/config.yaml — project-specific knobs only
//                                      (today: `bootstrap`). Overlays
//                                      global; project keys win.
//
// Legacy: `.swarm/config.jsonc` is read with a deprecation warning for one
// release. When both `.yaml` and `.jsonc` exist in the same layer, YAML
// wins and a "shadowed" warning is emitted. Delete `.jsonc` to silence it.
//
// Top-level keys merge shallowly between the two layers. Nested objects
// (`defaults`, `blobGc`, `skills`, `timeouts`, `summariser`) merge one level
// deep so a project config can override `defaults.llm_model` without losing
// the global `summariser` block.
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
import YAML from "yaml";

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
    llm: Type.Optional(TimeoutValue),
    tool: Type.Optional(TimeoutValue),
    bootstrap: Type.Optional(TimeoutValue),
    shell: Type.Optional(TimeoutValue),
    http: Type.Optional(TimeoutValue),
    leakGrace: Type.Optional(TimeoutValue),
    shutdownDrain: Type.Optional(TimeoutValue),
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

export const SwarmConfigSchema = Type.Object(
  {
    // Schema version. Currently always 1; bumped when the on-disk shape
    // changes in a way readers must opt into.
    version: Type.Optional(Type.Literal(1)),
    // UUIDv7 stable project identity, minted by `swarm init`. Optional
    // here so hand-rolled configs (e.g. `swarm init` predates the field)
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
    // `<project>/.swarm/config.yaml`, not the global config.
    bootstrap: Type.Optional(Type.String()),
    // Per-bootstrap timeout in milliseconds. Pairs with `bootstrap` —
    // ergonomically grouped at top level so a project that pins both
    // doesn't have to split across `bootstrap` + `timeouts.bootstrap`.
    // When both this and `timeouts.bootstrap` are set, this top-level
    // value wins (it's more explicit about belonging to bootstrap).
    // `timeouts.bootstrap` stays supported for back-compat and accepts
    // duration strings like `"10m"` — use that form when you'd rather
    // express "10 minutes" than "600000".
    bootstrapTimeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    defaults: Type.Optional(Defaults),
    // Weak-model summariser. Powers async run-title generation (autoTitle)
    // and per-node `summary=low|medium|high` transcript compression. Always
    // cheaper than the primary coding model. Omit to disable both paths.
    summariser: Type.Optional(Summariser),
    // Auto-generated run titles from the run's description (routing.input).
    // true (default) kicks off
    // a fire-and-forget summariser call at run start. false disables.
    // CLI flag --no-auto-title wins over this.
    autoTitle: Type.Optional(Type.Boolean()),
    // Command blocklist applied even in unsafe mode. Matched as literal
    // substrings against the shell command.
    blocklist: Type.Optional(Type.Array(Type.String())),
    // Max concurrent runs the daemon will claim from its queue. CLI
    // `--concurrency` overrides this. Default 16 when unset.
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
    web: Type.Optional(Web),
  },
  { additionalProperties: false },
);

export type SwarmConfig = Static<typeof SwarmConfigSchema>;

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
export function resolveTimeouts(cfg: SwarmConfig): ResolvedTimeouts {
  const out: ResolvedTimeouts = {};
  if (cfg.timeouts == null) return out;
  const keys = ["llm", "tool", "bootstrap", "shell", "http", "leakGrace", "shutdownDrain"] as const;
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

function formatValidationErrors(errors: Iterable<{ path: string; message: string }>): string {
  const list = [...errors].slice(0, 3);
  return list.map((e) => `${e.path || "<root>"}: ${e.message}`).join("; ");
}

// ─── Legacy JSONC stripper (retained for the deprecation-window reader) ───

function stripJsonc(src: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        out += c;
      }
      i++;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (inString) {
      if (c === "\\" && i + 1 < src.length) {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      out += c;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Parse a JSONC body. Returns the parsed object or throws with a
 * "parse error in <path>" message. */
function parseJsoncBody(body: string, filePath: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(body));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`config: parse error in ${filePath}: ${msg}`);
  }
  return parsed;
}

/** Parse a YAML body. Returns the parsed object or throws with a
 * "parse error in <path>" message. */
function parseYamlBody(body: string, filePath: string): unknown {
  try {
    return YAML.parse(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`config: parse error in ${filePath}: ${msg}`);
  }
}

/** Validate the parsed value against SwarmConfigSchema. Throws on failure. */
function validateParsed(parsed: unknown, filePath: string): SwarmConfig {
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`config: ${filePath} must be a JSON object`);
  }
  if (!Value.Check(SwarmConfigSchema, parsed)) {
    const msg = formatValidationErrors(Value.Errors(SwarmConfigSchema, parsed));
    throw new Error(`config: validation failed in ${filePath}: ${msg}`);
  }
  return parsed;
}

/** Parse and validate one config layer from a directory.
 *
 * Resolution order (per layer directory):
 *   1. `<dir>/.swarm/config.yaml` — canonical
 *   2. `<dir>/.swarm/config.jsonc` — legacy, emits a deprecation warning
 *
 * When both exist, YAML wins and a "shadowed" warning is emitted.
 * Returns `{}` when neither file is present. */
async function loadConfigFile(layerDir: string, layerLabel: "global" | "project"): Promise<SwarmConfig> {
  const yamlPath = resolve(layerDir, ".swarm/config.yaml");
  const jsoncPath = resolve(layerDir, ".swarm/config.jsonc");

  let yamlBody: string | null = null;
  let jsoncBody: string | null = null;

  try {
    yamlBody = await readFile(yamlPath, "utf8");
  } catch {
    // absent
  }
  try {
    jsoncBody = await readFile(jsoncPath, "utf8");
  } catch {
    // absent
  }

  if (yamlBody === null && jsoncBody === null) return {};

  if (yamlBody !== null && jsoncBody !== null) {
    console.warn(
      `config (${layerLabel}): ${jsoncPath} is shadowed by ${yamlPath} — delete the .jsonc file to silence this warning`,
    );
    return validateParsed(parseYamlBody(yamlBody, yamlPath), yamlPath);
  }

  if (yamlBody !== null) {
    return validateParsed(parseYamlBody(yamlBody, yamlPath), yamlPath);
  }

  // jsoncBody is non-null — legacy path
  console.warn(`config (${layerLabel}): ${jsoncPath} is deprecated — rename it to config.yaml to silence this warning`);
  return validateParsed(parseJsoncBody(jsoncBody!, jsoncPath), jsoncPath);
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

/** Load the merged user config: `~/.swarm/config.yaml` (global) overlaid
 * by `<cwd>/.swarm/config.yaml` (project). Either layer may be absent.
 * Legacy `.swarm/config.jsonc` is read with a deprecation warning.
 * Project keys win on collisions; nested objects merge one level deep.
 *
 * `opts.homeDir` overrides the global path's base — used by tests to
 * isolate from the user's real `~/.swarm/`. Production callers omit it. */
export async function loadConfig(cwd: string, opts: { homeDir?: string } = {}): Promise<SwarmConfig> {
  const globalDir = opts.homeDir ?? homedir();
  const [global, project] = await Promise.all([loadConfigFile(globalDir, "global"), loadConfigFile(cwd, "project")]);
  return mergeConfig(global, project);
}

/** Load *only* `<cwd>/.swarm/config.yaml` — no global cascade. Used
 * for keys that must be strictly project-scoped (e.g. `bootstrap`,
 * which is per-project tooling and would silently leak between
 * projects if the global layer was allowed to supply a default).
 * Returns `{}` when the project file is absent. */
export async function loadProjectConfig(cwd: string): Promise<SwarmConfig> {
  return loadConfigFile(cwd, "project");
}
