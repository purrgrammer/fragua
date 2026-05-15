// CLI providers-add flow after the credentials-in-the-store proposal
// landed. The interactive flow's literal/env/shell chooser is gone —
// keys are stored verbatim. We exercise the same `openGlobalStore +
// AuthStorage.fromStore + auth.set` pipeline the command uses,
// against a `$SWARM_HOME` pointed at a tmp dir.
//
// See docs/proposals/provider-credentials-storage.md.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@swarm/agent";
import { openGlobalStore } from "../src/commands/open-global-store.ts";

describe("providers add", () => {
  let tmp: string;
  let prevSwarmHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "swarm-providers-cli-"));
    prevSwarmHome = process.env["SWARM_HOME"];
    process.env["SWARM_HOME"] = tmp;
  });

  afterEach(() => {
    if (prevSwarmHome === undefined) delete process.env["SWARM_HOME"];
    else process.env["SWARM_HOME"] = prevSwarmHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("stores literal key verbatim and rejects no longer-prompted shell form", () => {
    // Drive the exact code path the add-command takes after the prompt:
    //   openGlobalStore() → AuthStorage.fromStore(store) → auth.set(...)
    const store = openGlobalStore();
    try {
      const auth = AuthStorage.fromStore(store);
      auth.set("anthropic", { type: "api_key", key: "sk-literal-cli" });
    } finally {
      store.close();
    }

    // Re-open against the same SWARM_HOME and confirm the row exists
    // with the verbatim key — no `!`-prefix normalisation, no shell-
    // form bookkeeping.
    const verify = openGlobalStore();
    try {
      const row = verify.getProviderCredential("anthropic");
      expect(row).not.toBeNull();
      expect(row!.kind).toBe("api_key");
      expect(row!.payload).toEqual({ type: "api_key", key: "sk-literal-cli" });

      // A `!cmd` string is no longer parsed as a shell-resolved key:
      // it persists verbatim and would be sent as-is to the provider.
      const auth = AuthStorage.fromStore(verify);
      auth.set("custom", { type: "api_key", key: "!op read 'op://x/y'" });
      const after = verify.getProviderCredential("custom");
      expect((after!.payload as { key: string }).key).toBe("!op read 'op://x/y'");
    } finally {
      verify.close();
    }
  });

  test("openGlobalStore creates ~/.swarm if missing and returns an open SqliteStore", () => {
    // Nested SWARM_HOME, parent doesn't exist yet; the helper mkdir -p's it.
    const nested = join(tmp, "deeper", "nest");
    process.env["SWARM_HOME"] = nested;

    const store = openGlobalStore();
    try {
      // Smoke: the migrator ran and the credentials table is queryable.
      expect(store.listProviderCredentials()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
