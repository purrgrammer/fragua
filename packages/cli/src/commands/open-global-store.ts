// Shared helper for CLI subcommands that need to read or write the
// global swarm store (credentials, schedules, etc.). The harness daemon
// owns this DB at runtime; CLI commands open a second connection
// briefly and close it before exiting.
//
// Per docs/proposals/provider-credentials-storage.md: providers
// commands always target `~/.swarm/swarm.db`, never the project-local
// `.swarm/swarm.db`, because credentials are global per-user.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getSwarmHome } from "@swarm/agent";
import { SqliteStore } from "@swarm/store";

/** Open the global swarm store at `~/.swarm/swarm.db` (honours
 *  `$SWARM_HOME`). Creates the parent directory if missing. Caller is
 *  responsible for `store.close()` \u2014 wrap usage in `try/finally`. */
export function openGlobalStore(): SqliteStore {
  const home = getSwarmHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return new SqliteStore({ path: join(home, "swarm.db") });
}
