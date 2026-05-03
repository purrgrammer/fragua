// Tests for .swarm/config.jsonc loading. Missing file returns `{}`
// for first-run UX. Malformed JSONC and schema-invalid content throw
// — silent fallback would hide typos that mis-route runs.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { loadConfig, loadProjectConfig, resolveTimeouts } from "../src/config.ts";

describe("loadConfig", () => {
  let scratch: string;
  let scratchHome: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-config-"));
    scratchHome = await mkdtemp(join(tmpdir(), "swarm-home-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
    await rm(scratchHome, { recursive: true, force: true });
  });

  async function write(body: string): Promise<void> {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(join(scratch, ".swarm/config.jsonc"), body, "utf8");
  }

  async function writeGlobal(body: string): Promise<void> {
    await mkdir(join(scratchHome, ".swarm"), { recursive: true });
    await writeFile(join(scratchHome, ".swarm/config.jsonc"), body, "utf8");
  }

  function load(): Promise<ReturnType<typeof loadConfig> extends Promise<infer T> ? T : never> {
    return loadConfig(scratch, { homeDir: scratchHome });
  }

  test("returns {} when both layers are missing", async () => {
    expect(await load()).toEqual({});
  });

  test("parses defaults.provider and defaults.model", async () => {
    await write(`{
      "defaults": {
        "llm_provider": "openrouter",
        "llm_model": "anthropic/claude-opus-4.7"
      }
    }`);
    const cfg = await load();
    expect(cfg.defaults?.llm_provider).toBe("openrouter");
    expect(cfg.defaults?.llm_model).toBe("anthropic/claude-opus-4.7");
  });

  test("accepts comments and trailing commas (JSONC features)", async () => {
    await write(`{
      // pin model so the demo doesn't drift
      "defaults": {
        "llm_provider": "ppq",
        "llm_model": "claude-sonnet-4.6",
      },
    }`);
    expect((await load()).defaults?.llm_provider).toBe("ppq");
  });

  test("throws on malformed JSONC (no silent fallback)", async () => {
    await write("{ this is not json }");
    await expect(load()).rejects.toThrow(/parse error/);
  });

  test("throws when the root is not an object", async () => {
    await write(`"just-a-string"`);
    await expect(load()).rejects.toThrow(/must be a JSON object/);
  });

  test("throws on schema violation (typo'd key)", async () => {
    await write(`{ "autoTitler": true }`);
    await expect(load()).rejects.toThrow(/validation failed/);
  });

  test("throws on snake_case key from the legacy YAML schema", async () => {
    await write(`{ "auto_title": true }`);
    await expect(load()).rejects.toThrow(/validation failed/);
  });

  test("parses runtime ceilings: maxQueuedRuns, abortLoopCeiling, maxLeakedHandlers", async () => {
    await write(`{
      "maxQueuedRuns": 500,
      "abortLoopCeiling": 8,
      "maxLeakedHandlers": 2
    }`);
    const cfg = await load();
    expect(cfg.maxQueuedRuns).toBe(500);
    expect(cfg.abortLoopCeiling).toBe(8);
    expect(cfg.maxLeakedHandlers).toBe(2);
  });

  test("parses the timeouts section with leakGrace + shutdownDrain", async () => {
    await write(`{
      "timeouts": {
        "codergen": "30m",
        "tool": "5m",
        "http": "30s",
        "leakGrace": "10s",
        "shutdownDrain": "30s"
      }
    }`);
    const cfg = await load();
    expect(cfg.timeouts?.codergen).toBe("30m");
    expect(cfg.timeouts?.tool).toBe("5m");
    expect(cfg.timeouts?.http).toBe("30s");
    expect(cfg.timeouts?.leakGrace).toBe("10s");
    expect(cfg.timeouts?.shutdownDrain).toBe("30s");
  });

  test("global → project cascade: project keys win, nested objects merge one level deep", async () => {
    await writeGlobal(`{
      "defaults": {
        "llm_provider": "anthropic",
        "llm_model": "claude-sonnet-4.7",
        "summariser": { "llm_provider": "anthropic", "llm_model": "claude-haiku-4.6" }
      },
      "autoTitle": true,
      "blocklist": ["sudo "]
    }`);
    await write(`{
      "bootstrap": "bun install --frozen-lockfile",
      "defaults": { "llm_model": "claude-opus-4.7" }
    }`);
    const cfg = await load();
    expect(cfg.bootstrap).toBe("bun install --frozen-lockfile");
    expect(cfg.defaults?.llm_provider).toBe("anthropic"); // from global
    expect(cfg.defaults?.llm_model).toBe("claude-opus-4.7"); // project override
    expect(cfg.defaults?.summariser?.llm_model).toBe("claude-haiku-4.6"); // global wins (project didn't set)
    expect(cfg.autoTitle).toBe(true); // global only
    expect(cfg.blocklist).toEqual(["sudo "]); // global only
  });

  test("global only: project file absent, global config flows through", async () => {
    await writeGlobal(`{ "autoTitle": false, "concurrency": 2 }`);
    const cfg = await load();
    expect(cfg.autoTitle).toBe(false);
    expect(cfg.concurrency).toBe(2);
  });

  test("parses web.port from the global config", async () => {
    await writeGlobal(`{ "web": { "port": 9999 } }`);
    const cfg = await load();
    expect(cfg.web?.port).toBe(9999);
  });

  test("rejects out-of-range web.port", async () => {
    await writeGlobal(`{ "web": { "port": 70000 } }`);
    await expect(load()).rejects.toThrow(/validation failed/);
  });
});

describe("loadProjectConfig", () => {
  let scratch: string;
  let scratchHome: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-projectconfig-"));
    scratchHome = await mkdtemp(join(tmpdir(), "swarm-projectconfig-home-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
    await rm(scratchHome, { recursive: true, force: true });
  });

  test("returns {} when the project config is absent", async () => {
    expect(await loadProjectConfig(scratch)).toEqual({});
  });

  test("ignores the global config — local-only by design", async () => {
    // bootstrap is per-project tooling: a global default would silently
    // leak into projects that didn't opt in. loadProjectConfig must not
    // see the global layer at all.
    await mkdir(join(scratchHome, ".swarm"), { recursive: true });
    await writeFile(
      join(scratchHome, ".swarm/config.jsonc"),
      `{ "bootstrap": "global-cmd" }`,
      "utf8",
    );
    // Note: loadProjectConfig doesn't take a homeDir override because
    // it never reads the home dir. The presence of the file in the
    // user's real ~/.swarm/ would be irrelevant either way.
    expect(await loadProjectConfig(scratch)).toEqual({});
  });

  test("reads <cwd>/.swarm/config.jsonc verbatim", async () => {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(
      join(scratch, ".swarm/config.jsonc"),
      `{ "bootstrap": "pnpm install --frozen-lockfile" }`,
      "utf8",
    );
    const cfg = await loadProjectConfig(scratch);
    expect(cfg.bootstrap).toBe("pnpm install --frozen-lockfile");
  });

  test("propagates parse + validation errors (no silent fallback)", async () => {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(join(scratch, ".swarm/config.jsonc"), `{ "bootstrap": 123 }`, "utf8");
    await expect(loadProjectConfig(scratch)).rejects.toThrow(/validation failed/);
  });
});

describe("resolveTimeouts", () => {
  test("absent section → empty object", () => {
    expect(resolveTimeouts({})).toEqual({});
  });

  test("each key parses through parseDurationMs", () => {
    const r = resolveTimeouts({
      timeouts: {
        codergen: "30m",
        tool: "5m",
        bootstrap: 600_000,
        shell: "30s",
        http: "30s",
        leakGrace: "10s",
        shutdownDrain: "30s",
      },
    });
    expect(r.codergen).toBe(30 * 60 * 1000);
    expect(r.tool).toBe(5 * 60 * 1000);
    expect(r.bootstrap).toBe(600_000);
    expect(r.shell).toBe(30_000);
    expect(r.http).toBe(30_000);
    expect(r.leakGrace).toBe(10_000);
    expect(r.shutdownDrain).toBe(30_000);
  });

  test("invalid value throws with config-prefixed message", () => {
    expect(() => resolveTimeouts({ timeouts: { codergen: "garbage" } })).toThrow(/config: timeouts\.codergen:/);
  });

  test("unset keys stay undefined (caller falls through to handler defaults)", () => {
    const r = resolveTimeouts({ timeouts: { codergen: "10m" } });
    expect(r.codergen).toBe(10 * 60 * 1000);
    expect(r.tool).toBeUndefined();
    expect(r.http).toBeUndefined();
  });

  test("property — any valid duration string round-trips", () => {
    const validDuration = fc
      .tuple(fc.integer({ min: 1, max: 10_000 }), fc.constantFrom("ms", "s", "m", "h"))
      .map(([n, u]) => [`${n}${u}`, n * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[u] ?? 1)] as const);
    fc.assert(
      fc.property(validDuration, ([input, expected]) => {
        expect(resolveTimeouts({ timeouts: { codergen: input } }).codergen).toBe(expected);
      }),
    );
  });

  test("property — any invalid value surfaces a config-prefixed error", () => {
    const badValue = fc.oneof(
      fc.constantFrom("garbage", "", "   ", "0s", "-1", "5x", "1.5m"),
      fc.integer({ min: -1_000, max: 0 }),
    );
    fc.assert(
      fc.property(badValue, (v) => {
        expect(() => resolveTimeouts({ timeouts: { codergen: v as string | number } })).toThrow(/config: timeouts\./);
      }),
    );
  });
});
