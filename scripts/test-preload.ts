// Test preload (bunfig.toml [test].preload): point $FRAGUA_HOME at a throwaway
// temp dir so no test ever opens the operator's live ~/.fragua store. Code that
// falls back to the global store — getDefaultRegistry, seedCredsFromGlobalStore
// — now lands on an ephemeral file DB instead of the developer's real one.
//
// Only set when unset: tests that manage FRAGUA_HOME themselves still win, and
// they save/restore the value (which is now this temp dir rather than undefined).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env["FRAGUA_HOME"]) {
  const home = mkdtempSync(join(tmpdir(), "fragua-test-home-"));
  process.env["FRAGUA_HOME"] = home;
  process.on("exit", () => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {}
  });
}
