// Fragua home directory.
//
// All persistent state (provider credentials, custom-provider config,
// runs, blobs, workflows) lives under `~/.fragua/` in the global store
// (`~/.fragua/fragua.db`). The credentials proposal moved built-in
// provider keys into `provider_credentials`; the follow-up
// provider-config-storage proposal moved custom-provider definitions
// into `provider_config`. There is no longer a `~/.fragua/auth.json`
// or `~/.fragua/models.json` on disk.
//
// `FRAGUA_HOME` overrides the base directory (tests, one-off installs).

import { homedir } from "node:os";
import { join } from "node:path";

/** Base directory for fragua global state. Honours $FRAGUA_HOME. */
export function getFraguaHome(): string {
  const env = process.env["FRAGUA_HOME"];
  if (env) {
    if (env === "~") return homedir();
    if (env.startsWith("~/")) return homedir() + env.slice(1);
    return env;
  }
  return join(homedir(), ".fragua");
}
