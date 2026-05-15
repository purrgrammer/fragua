// Custom-provider model-config file paths.
//
// Built-in provider credentials (api_key + OAuth) live in the global
// store (`~/.swarm/swarm.db`, `provider_credentials` table) since the
// credentials-in-the-store proposal landed. The remaining file path
// here is for custom-provider *definitions* (Ollama, vLLM, LM Studio,
// proxies) — `~/.swarm/models.json` — which the follow-up
// provider-config-storage proposal will lift into the store.
//
// Swarm is globally-scoped for credentials and custom models: one user,
// one machine, one set of keys and custom providers, shared across
// every workspace. This matches how aws/gcloud/ssh/gh treat auth.
//
//   ~/.swarm/swarm.db    — provider_credentials + ModelRegistry config
//                          (api_key + oauth credentials live in the DB)
//   ~/.swarm/models.json — ModelRegistry (custom providers + overrides;
//                          PR2 moves this into provider_config)
//
// `SWARM_HOME` overrides the base directory (tests, one-off installs).
// `~/.pi/agent/models.json` is a one-time bootstrap source: if
// `~/.swarm/models.json` doesn't exist yet but the pi file does, swarm
// COPIES the pi content over on first access. After that, swarm writes
// go to `~/.swarm/*` only.

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

/** Absolute path to ~/.swarm/models.json. File does not need to exist. */
export function getModelsPath(): string {
  return join(getSwarmHome(), "models.json");
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
    statSync(src);
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

/** Run the models.json bootstrap. Call once at ModelRegistry
 * construction time. Safe to call repeatedly. Returns whether a
 * copy was performed (so the CLI can surface "imported from pi" as a
 * one-time notice). The auth half is gone — credentials live in the
 * store, not on disk. */
export function bootstrapSwarmHomeFromPi(): { models: boolean } {
  const models = bootstrapFromPi(getPiFallbackModelsPath(), getModelsPath(), 0o644);
  return { models };
}

/** Resolve the models.json file path to use. Always returns the swarm
 * path. If the swarm file doesn't exist yet but the pi file does, the
 * pi content is copied over first (one-time bootstrap). */
export function resolveModelsPath(): string {
  bootstrapSwarmHomeFromPi();
  return getModelsPath();
}
