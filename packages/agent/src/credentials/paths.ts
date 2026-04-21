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
// `~/.pi/agent/{auth,models}.json` is honoured as a *read-only* fallback
// when neither swarm file exists — zero-config carryover for users who
// already set up pi-coding-agent. Swarm never writes to the pi path.
//
// The door is intentionally left open for per-workspace overlays: when
// we add them they'll only override model *selection defaults*; the
// credential layer stays global so a steered run on workspace A can't
// exfiltrate keys configured for workspace B.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/** pi-coding-agent auth.json — read-only fallback when swarm's doesn't exist. */
export function getPiFallbackAuthPath(): string {
  return join(homedir(), ".pi", "agent", "auth.json");
}

/** pi-coding-agent models.json — read-only fallback when swarm's doesn't exist. */
export function getPiFallbackModelsPath(): string {
  return join(homedir(), ".pi", "agent", "models.json");
}

/** Resolve the auth file path to use: swarm path if it exists, else the
 * pi fallback if that exists, else the swarm path (creation target). */
export function resolveAuthPath(): string {
  const swarmPath = getAuthPath();
  if (existsSync(swarmPath)) return swarmPath;
  const piPath = getPiFallbackAuthPath();
  if (existsSync(piPath)) return piPath;
  return swarmPath;
}

/** Same semantics as resolveAuthPath, for models.json. */
export function resolveModelsPath(): string {
  const swarmPath = getModelsPath();
  if (existsSync(swarmPath)) return swarmPath;
  const piPath = getPiFallbackModelsPath();
  if (existsSync(piPath)) return piPath;
  return swarmPath;
}
