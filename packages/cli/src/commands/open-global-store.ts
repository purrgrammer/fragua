// Shared helper for CLI subcommands that need to read or write the
// global fragua store (credentials, schedules, etc.). The harness daemon
// owns this DB at runtime; CLI commands open a second connection
// briefly and close it before exiting.
//
// Providers commands always target `~/.fragua/fragua.db`, never the
// project-local `.fragua/fragua.db`, because credentials are global per-user.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getFraguaHome } from "@fragua/agent";
import { SqliteStore } from "@fragua/store";

/** Open the global fragua store at `~/.fragua/fragua.db` (honours
 *  `$FRAGUA_HOME`). Creates the parent directory if missing. Caller is
 *  responsible for `store.close()` \u2014 wrap usage in `try/finally`. */
export function openGlobalStore(): SqliteStore {
  const home = getFraguaHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return new SqliteStore({ path: join(home, "fragua.db") });
}
