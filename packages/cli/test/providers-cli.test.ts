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
import { JUDGE_DEFAULT_MODEL, JUDGE_DEFAULT_PROVIDER } from "@fragua/core";
import { openGlobalStore } from "../src/commands/open-global-store.ts";
import { providersListCommand } from "../src/commands/providers.ts";

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

describe("providers ls — the judge provider", () => {
  let tmp: string;
  let prevFraguaHome: string | undefined;
  let lines: string[];
  let restore: (() => void) | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fragua-providers-judge-"));
    prevFraguaHome = process.env["FRAGUA_HOME"];
    process.env["FRAGUA_HOME"] = tmp;
    lines = [];
    const real = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
    restore = () => {
      console.log = real;
    };
  });

  afterEach(() => {
    restore?.();
    if (prevFraguaHome === undefined) delete process.env["FRAGUA_HOME"];
    else process.env["FRAGUA_HOME"] = prevFraguaHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  // `typesafe` is a System One endpoint, not an LLM catalogue entry, so pi-ai's
  // registry has no models for it. The listing is built from that registry, so
  // a credentialed judge provider was invisible here and the tally read 0 —
  // leaving `fragua providers add typesafe`, the documented judge setup step,
  // with no way to confirm itself.
  test("appears in the listing even with no catalogue models", () => {
    expect(providersListCommand()).toBe(0);
    const row = lines.find((l) => l.includes(JUDGE_DEFAULT_PROVIDER));
    expect(row).toBeDefined();
    expect(row).toContain(JUDGE_DEFAULT_MODEL);
  });

  test("a stored judge credential is counted as credentialed", () => {
    const store = openGlobalStore();
    try {
      AuthStorage.fromStore(store).set(JUDGE_DEFAULT_PROVIDER, { type: "api_key", key: "sk-typesafe-test" });
    } finally {
      store.close();
    }
    expect(providersListCommand()).toBe(0);
    const row = lines.find((l) => l.includes(JUDGE_DEFAULT_PROVIDER));
    expect(row).toContain("✓");
    // The tally must move: it read "0/N credentialed" with the key stored.
    expect(lines.some((l) => /(?:^|\s)0\/\d+ providers credentialed/.test(l))).toBe(false);
    expect(lines.some((l) => /[1-9]\d*\/\d+ providers credentialed/.test(l))).toBe(true);
  });
});
