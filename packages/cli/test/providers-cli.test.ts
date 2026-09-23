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
import { AuthStorage, getFraguaHome, ModelRegistry } from "@fragua/agent";
import { JUDGE_DEFAULT_MODEL, JUDGE_DEFAULT_PROVIDER } from "@fragua/core";
import { registryPreflight } from "@fragua/server";
import { openGlobalStore } from "../src/commands/open-global-store.ts";
import { providersListCommand } from "../src/commands/providers.ts";
import { resolveStorePath } from "../src/store-client.ts";

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

describe("the judge provider is first-class", () => {
  let tmp: string;
  let prevFraguaHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fragua-judge-firstclass-"));
    prevFraguaHome = process.env["FRAGUA_HOME"];
    process.env["FRAGUA_HOME"] = tmp;
  });

  afterEach(() => {
    if (prevFraguaHome === undefined) delete process.env["FRAGUA_HOME"];
    else process.env["FRAGUA_HOME"] = prevFraguaHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  // A workflow of `judge` + `tool` steps needs no LLM provider, so `typesafe`
  // alone is a complete setup. The server's preflight counted pi-ai MODELS,
  // and typesafe contributes none — so that operator was told "no provider
  // credentials configured" and could not create a run at all.
  test("a judge-only credential satisfies the run-creation preflight", () => {
    const store = openGlobalStore();
    try {
      const auth = AuthStorage.fromStore(store);
      auth.set(JUDGE_DEFAULT_PROVIDER, { type: "api_key", key: "sk-typesafe-test" });
      const registry = ModelRegistry.create(auth, store);

      // The old gate, kept here so the regression is visible rather than implied.
      expect(registry.getAvailable().length).toBe(0);

      const gate = registryPreflight({
        hasAnyAuth: () => registry.getAvailable().length > 0 || auth.list().length > 0,
      });
      expect(gate().ok).toBe(true);
    } finally {
      store.close();
    }
  });

  test("no credentials at all still fails the preflight", () => {
    const store = openGlobalStore();
    try {
      const auth = AuthStorage.fromStore(store);
      const registry = ModelRegistry.create(auth, store);
      const gate = registryPreflight({
        hasAnyAuth: () => registry.getAvailable().length > 0 || auth.list().length > 0,
      });
      const res = gate();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.detail).toContain("no provider credentials configured");
    } finally {
      store.close();
    }
  });

  // `providers` resolved the home through getFraguaHome(); every store-client
  // command hard-coded ~/.fragua, so FRAGUA_HOME moved one surface and not the
  // other and the two could report on different stores.
  test("store-client and providers resolve the same FRAGUA_HOME", () => {
    expect(resolveStorePath({})).toBe(join(tmp, "fragua.db"));
    expect(resolveStorePath({})).toBe(join(getFraguaHome(), "fragua.db"));
  });

  test("an explicit --db still wins over FRAGUA_HOME", () => {
    expect(resolveStorePath({ dbPath: join(tmp, "other.db") })).toBe(join(tmp, "other.db"));
  });
});
