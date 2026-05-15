// Swarm home directory.
//
// All persistent state (provider credentials, custom-provider config,
// runs, blobs, workflows) lives under `~/.swarm/` in the global store
// (`~/.swarm/swarm.db`). The credentials proposal moved built-in
// provider keys into `provider_credentials`; the follow-up
// provider-config-storage proposal moved custom-provider definitions
// into `provider_config`. There is no longer a `~/.swarm/auth.json`
// or `~/.swarm/models.json` on disk.
//
// `SWARM_HOME` overrides the base directory (tests, one-off installs).

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
