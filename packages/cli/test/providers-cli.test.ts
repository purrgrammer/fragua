// CLI providers-add flow after the credentials-in-the-store proposal
// landed. The interactive flow's literal/env/shell chooser is gone —
// keys are stored verbatim. We exercise the same `openGlobalStore +
// AuthStorage.fromStore + auth.set` pipeline the command uses,
// against a `$FRAGUA_HOME` pointed at a tmp dir.
//

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@fragua/agent";
import { openGlobalStore } from "../src/commands/open-global-store.ts";

describe("providers add", () => {
  let tmp: string;
  let prevFraguaHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fragua-providers-cli-"));
    prevFraguaHome = process.env["FRAGUA_HOME"];
    process.env["FRAGUA_HOME"] = tmp;
  });

  afterEach(() => {
    if (prevFraguaHome === undefined) delete process.env["FRAGUA_HOME"];
    else process.env["FRAGUA_HOME"] = prevFraguaHome;
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

    // Re-open against the same FRAGUA_HOME and confirm the row exists
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

  test("openGlobalStore creates ~/.fragua if missing and returns an open SqliteStore", () => {
    // Nested FRAGUA_HOME, parent doesn't exist yet; the helper mkdir -p's it.
    const nested = join(tmp, "deeper", "nest");
    process.env["FRAGUA_HOME"] = nested;

    const store = openGlobalStore();
    try {
      // Smoke: the migrator ran and the credentials table is queryable.
      expect(store.listProviderCredentials()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
