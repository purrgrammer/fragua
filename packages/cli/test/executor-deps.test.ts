// buildExecutorDeps — the shared executor-assembly factory (daemon + ci).
// The regression surface that matters here is the provider/model resolution
// precedence (flags > config defaults > env-autodetect > stub) and the
// shape of the wired deps. A fresh in-memory store has no credential rows,
// so env-autodetect can't fire — "stub" is the floor.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Dispatcher } from "@fragua/daemon";
import { SqliteStore } from "@fragua/store";
import { type FraguaConfig, loadConfig, resolveTimeouts } from "../src/config.ts";
import { buildExecutorDeps } from "../src/executor-deps.ts";

let store: SqliteStore;
let dir: string;
let baseConfig: FraguaConfig;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "fragua-execdeps-"));
  store = new SqliteStore({ path: ":memory:" });
  // Pin homeDir to the (empty) temp dir so neither the global config layer
  // nor user-scope skills are read from the operator's real `~`.
  baseConfig = await loadConfig(dir, { homeDir: dir });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("buildExecutorDeps", () => {
  test("no flags, no config defaults, no creds → stub (real llm path off)", async () => {
    const deps = await buildExecutorDeps({
      store,
      cwd: dir,
      config: baseConfig,
      timeouts: resolveTimeouts(baseConfig),
      homeDir: dir,
    });
    expect(deps.llm.source).toBe("stub");
    expect(deps.llm.useLlm).toBe(false);
    expect(deps.llm.provider).toBeUndefined();
    expect(deps.llm.model).toBeUndefined();
    // No real llm path ⇒ no steer-buffer registry.
    expect(deps.steeringRegistry).toBeUndefined();
    // Stub deps are still present so the executor can run tool/transition nodes.
    expect(deps.dispatcher).toBeInstanceOf(Dispatcher);
    expect(deps.tools).toBeDefined();
    expect(deps.llmCall).toBeDefined();
    expect(deps.graphLoader).toBeDefined();
  });

  test("flags win and wire the real llm path", async () => {
    const deps = await buildExecutorDeps({
      store,
      cwd: dir,
      config: baseConfig,
      timeouts: resolveTimeouts(baseConfig),
      homeDir: dir,
      provider: "testprov",
      model: "testmodel",
    });
    expect(deps.llm.source).toBe("flags");
    expect(deps.llm.useLlm).toBe(true);
    expect(deps.llm.provider).toBe("testprov");
    expect(deps.llm.model).toBe("testmodel");
    // Real llm path ⇒ the shared steer-buffer registry exists.
    expect(deps.steeringRegistry).toBeDefined();
  });

  test("config defaults are used when no flags are passed", async () => {
    const config: FraguaConfig = { ...baseConfig, defaults: { provider: "cfgprov", model: "cfgmodel" } };
    const deps = await buildExecutorDeps({ store, cwd: dir, config, timeouts: resolveTimeouts(config), homeDir: dir });
    expect(deps.llm.source).toBe("config");
    expect(deps.llm.provider).toBe("cfgprov");
    expect(deps.llm.model).toBe("cfgmodel");
    expect(deps.llm.useLlm).toBe(true);
  });

  test("flags override config defaults", async () => {
    const config: FraguaConfig = { ...baseConfig, defaults: { provider: "cfgprov", model: "cfgmodel" } };
    const deps = await buildExecutorDeps({
      store,
      cwd: dir,
      config,
      timeouts: resolveTimeouts(config),
      homeDir: dir,
      provider: "flagprov",
      model: "flagmodel",
    });
    expect(deps.llm.source).toBe("flags");
    expect(deps.llm.provider).toBe("flagprov");
    expect(deps.llm.model).toBe("flagmodel");
  });
});
