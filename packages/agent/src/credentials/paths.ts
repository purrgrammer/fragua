// Credential / model-config file paths.
//
// Swarm is globally-scoped for credentials: one user, one machine, one
// set of keys and custom models, shared across every workspace. This
// matches how aws/gcloud/ssh/gh treat auth.
//
//   ~/.swarm/auth.json     — AuthStorage (api_key + oauth credentials)
//   ~/.swarm/models.json   — ModelRegistry (custom providers + overrides)
//
// `SWARM_HOME` overrides the base directory (tests, one-off installs).
// `~/.pi/agent/{auth,models}.json` is a one-time bootstrap source: if
// `~/.swarm/auth.json` doesn't exist yet but the pi file does, swarm
// COPIES the pi content over on first access. After that, swarm writes
// go to `~/.swarm/*` only — the pi file is never modified. This was a
// prior bug: treating pi as a live fallback meant `swarm providers add`
// wrote into pi-coding-agent's state, violating single-source-of-truth
// and surprising users who had stale keys in pi.
//
// The door is intentionally left open for per-workspace overlays: when
// we add them they'll only override model *selection defaults*; the
// credential layer stays global so a steered run on workspace A can't
// exfiltrate keys configured for workspace B.

import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Base directory for swarm global state. Honours $SWARM_HOME. */
export function getSwarmHome(): string {
  const env = process.env["SWARM_HOME"];
  if (env) {
    if (env === "~") return homedir();
    if (env.startsWith("~/")) return homedir() + env.slice(1);
    return env;
  }
  return join(homedir(), ".swarm");
}

/** Absolute path to ~/.swarm/auth.json. File does not need to exist. */
export function getAuthPath(): string {
  return join(getSwarmHome(), "auth.json");
}

/** Absolute path to ~/.swarm/models.json. File does not need to exist. */
export function getModelsPath(): string {
  return join(getSwarmHome(), "models.json");
}

/** pi-coding-agent auth.json — bootstrap source (see file header). */
export function getPiFallbackAuthPath(): string {
  return join(homedir(), ".pi", "agent", "auth.json");
}

/** pi-coding-agent models.json — bootstrap source. */
export function getPiFallbackModelsPath(): string {
  return join(homedir(), ".pi", "agent", "models.json");
}

/** Copy `src` → `dst` if `src` exists and `dst` doesn't. Creates
 * `dst`'s parent dir at 0700 and chmods the file to 0600 afterward.
 * Idempotent — no-op if `dst` already exists. Returns `true` when a
 * copy was performed (useful for surface logging in the CLI). */
function bootstrapFromPi(src: string, dst: string, mode: number): boolean {
  if (existsSync(dst)) return false;
  if (!existsSync(src)) return false;
  try {
    statSync(src); // readable check
  } catch {
    return false;
  }
  const parent = dirname(dst);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  copyFileSync(src, dst);
  try {
    chmodSync(dst, mode);
  } catch {
    // best effort; copyFileSync may have already preserved mode on unix
  }
  return true;
}

/** Run both bootstraps. Call once at AuthStorage / ModelRegistry
 * construction time. Safe to call repeatedly. Returns a small record
 * describing what happened so the CLI can surface "imported from pi"
 * as a one-time notice. */
export function bootstrapSwarmHomeFromPi(): { auth: boolean; models: boolean } {
  const auth = bootstrapFromPi(getPiFallbackAuthPath(), getAuthPath(), 0o600);
  const models = bootstrapFromPi(getPiFallbackModelsPath(), getModelsPath(), 0o644);
  return { auth, models };
}

/** Resolve the auth file path to use. Always returns the swarm path.
 * If the swarm file doesn't exist yet but the pi file does, the pi
 * content is copied over first (one-time bootstrap). Reads and writes
 * thereafter both go to the swarm path. */
export function resolveAuthPath(): string {
  bootstrapSwarmHomeFromPi();
  return getAuthPath();
}

/** Same semantics as resolveAuthPath, for models.json. */
export function resolveModelsPath(): string {
  bootstrapSwarmHomeFromPi();
  return getModelsPath();
}
