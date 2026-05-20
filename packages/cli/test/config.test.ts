// Tests for .swarm/config.yaml loading. Missing file returns `{}`
// for first-run UX. Malformed YAML and schema-invalid content throw
// — silent fallback would hide typos that mis-route runs.
// Legacy .swarm/config.jsonc is read with a deprecation warning.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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

  async function write(body: string, ext: "yaml" | "jsonc" = "yaml"): Promise<void> {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(join(scratch, `.swarm/config.${ext}`), body, "utf8");
  }

  async function writeGlobal(body: string, ext: "yaml" | "jsonc" = "yaml"): Promise<void> {
    await mkdir(join(scratchHome, ".swarm"), { recursive: true });
    await writeFile(join(scratchHome, `.swarm/config.${ext}`), body, "utf8");
  }

  function load(): Promise<ReturnType<typeof loadConfig> extends Promise<infer T> ? T : never> {
    return loadConfig(scratch, { homeDir: scratchHome });
  }

  test("returns {} when both layers are missing", async () => {
    expect(await load()).toEqual({});
  });

  test("parses defaults.provider and defaults.model", async () => {
    await write(`
defaults:
  provider: openrouter
  model: "anthropic/claude-opus-4.7"
`);
    const cfg = await load();
    expect(cfg.defaults?.provider).toBe("openrouter");
    expect(cfg.defaults?.model).toBe("anthropic/claude-opus-4.7");
  });

  test("throws on malformed YAML (no silent fallback)", async () => {
    await write("key: [unclosed");
    await expect(load()).rejects.toThrow(/parse error/);
  });

  test("throws when the root is not a mapping", async () => {
    await write(`"just-a-string"`);
    await expect(load()).rejects.toThrow(/must be a JSON object/);
  });

  test("throws on schema violation (typo'd key)", async () => {
    await write(`autoTitler: true`);
    await expect(load()).rejects.toThrow(/validation failed/);
  });

  test("throws on snake_case key from the legacy YAML schema", async () => {
    await write(`auto_title: true`);
    await expect(load()).rejects.toThrow(/validation failed/);
  });

  test("rejects the pre-rename camelCase key (autoTitle)", async () => {
    await write(`autoTitle: true`);
    await expect(load()).rejects.toThrow(/validation failed/);
  });

  test("parses runtime ceilings: max-queued-runs, abort-loop-ceiling, max-leaked-handlers", async () => {
    await write(`
max-queued-runs: 500
abort-loop-ceiling: 8
max-leaked-handlers: 2
`);
    const cfg = await load();
    expect(cfg["max-queued-runs"]).toBe(500);
    expect(cfg["abort-loop-ceiling"]).toBe(8);
    expect(cfg["max-leaked-handlers"]).toBe(2);
  });

  test("parses the timeouts section with leak-grace + shutdown-drain", async () => {
    await write(`
timeouts:
  llm: "30m"
  tool: "5m"
  http: "30s"
  leak-grace: "10s"
  shutdown-drain: "30s"
`);
    const cfg = await load();
    expect(cfg.timeouts?.llm).toBe("30m");
    expect(cfg.timeouts?.tool).toBe("5m");
    expect(cfg.timeouts?.http).toBe("30s");
    expect(cfg.timeouts?.["leak-grace"]).toBe("10s");
    expect(cfg.timeouts?.["shutdown-drain"]).toBe("30s");
  });

  test("parses every renamed kebab key end-to-end", async () => {
    await writeGlobal(`
auto-title: false
max-loops: 42
max-queued-runs: 10
abort-loop-ceiling: 3
max-leaked-handlers: 5
bootstrap-timeout-ms: 60000
blob-gc:
  max-rows: 200
skills:
  trust-project: false
timeouts:
  leak-grace: "5s"
  shutdown-drain: "15s"
`);
    const cfg = await load();
    expect(cfg["auto-title"]).toBe(false);
    expect(cfg["max-loops"]).toBe(42);
    expect(cfg["max-queued-runs"]).toBe(10);
    expect(cfg["abort-loop-ceiling"]).toBe(3);
    expect(cfg["max-leaked-handlers"]).toBe(5);
    expect(cfg["bootstrap-timeout-ms"]).toBe(60000);
    expect(cfg["blob-gc"]?.["max-rows"]).toBe(200);
    expect(cfg.skills?.["trust-project"]).toBe(false);
    expect(cfg.timeouts?.["leak-grace"]).toBe("5s");
    expect(cfg.timeouts?.["shutdown-drain"]).toBe("15s");
  });

  test("global → project cascade: project keys win, nested objects merge one level deep", async () => {
    await writeGlobal(`
defaults:
  provider: anthropic
  model: claude-sonnet-4.7
summariser:
  provider: anthropic
  model: claude-haiku-4.6
auto-title: true
blocklist:
  - "sudo "
`);
    await write(`
bootstrap: "bun install --frozen-lockfile"
defaults:
  model: claude-opus-4.7
`);
    const cfg = await load();
    expect(cfg.bootstrap).toBe("bun install --frozen-lockfile");
    expect(cfg.defaults?.provider).toBe("anthropic"); // from global
    expect(cfg.defaults?.model).toBe("claude-opus-4.7"); // project override
    expect(cfg.summariser?.model).toBe("claude-haiku-4.6"); // global wins (project didn't set)
    expect(cfg["auto-title"]).toBe(true); // global only
    expect(cfg.blocklist).toEqual(["sudo "]); // global only
  });

  test("hoisted summariser key validates at the top level (not under defaults)", async () => {
    await writeGlobal(`
summariser:
  provider: anthropic
  model: claude-haiku-4-5
`);
    const cfg = await load();
    expect(cfg.summariser?.provider).toBe("anthropic");
    expect(cfg.summariser?.model).toBe("claude-haiku-4-5");
  });

  test("rejects legacy defaults.summariser nesting", async () => {
    await writeGlobal(`
defaults:
  summariser:
    provider: anthropic
`);
    await expect(load()).rejects.toThrow(/validation failed/);
  });

  test("global only: project file absent, global config flows through", async () => {
    await writeGlobal(`
auto-title: false
concurrency: 2
`);
    const cfg = await load();
    expect(cfg["auto-title"]).toBe(false);
    expect(cfg.concurrency).toBe(2);
  });

  test("parses web.port from the global config", async () => {
    await writeGlobal(`
web:
  port: 9999
`);
    const cfg = await load();
    expect(cfg.web?.port).toBe(9999);
  });

  test("rejects out-of-range web.port", async () => {
    await writeGlobal(`
web:
  port: 70000
`);
    await expect(load()).rejects.toThrow(/validation failed/);
  });

  // ─── YAML format tests ──────────────────────────────────────────────

  describe("YAML format", () => {
    test("reads <cwd>/.swarm/config.yaml", async () => {
      await write(`
defaults:
  provider: openrouter
  model: "anthropic/claude-opus-4.7"
`);
      const cfg = await load();
      expect(cfg.defaults?.provider).toBe("openrouter");
    });

    test("YAML wins when both .yaml and .jsonc exist in the same layer", async () => {
      await mkdir(join(scratch, ".swarm"), { recursive: true });
      await writeFile(join(scratch, ".swarm/config.yaml"), `bootstrap: "yaml-bootstrap"`, "utf8");
      await writeFile(join(scratch, ".swarm/config.jsonc"), `{ "bootstrap": "jsonc-bootstrap" }`, "utf8");
      const cfg = await load();
      expect(cfg.bootstrap).toBe("yaml-bootstrap");
    });

    test("emits a deprecation warning when .jsonc shadows present .yaml", async () => {
      await mkdir(join(scratch, ".swarm"), { recursive: true });
      await writeFile(join(scratch, ".swarm/config.yaml"), `bootstrap: "yaml-bootstrap"`, "utf8");
      await writeFile(join(scratch, ".swarm/config.jsonc"), `{ "bootstrap": "jsonc-bootstrap" }`, "utf8");
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await load();
        const calls = warnSpy.mock.calls.map((c) => c.join(" "));
        expect(calls.some((m) => m.includes("shadowed"))).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("emits a deprecation warning when only .jsonc is present", async () => {
      await mkdir(join(scratch, ".swarm"), { recursive: true });
      await writeFile(join(scratch, ".swarm/config.jsonc"), `{ "bootstrap": "old-style" }`, "utf8");
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await load();
        const calls = warnSpy.mock.calls.map((c) => c.join(" "));
        expect(calls.some((m) => m.includes("deprecated"))).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("throws on malformed YAML (no silent fallback)", async () => {
      await write("key: [unclosed bracket");
      await expect(load()).rejects.toThrow(/parse error/);
    });

    test("throws on YAML schema violation", async () => {
      await write(`auto_title: true`);
      await expect(load()).rejects.toThrow(/validation failed/);
    });

    test("YAML supports the full cascade", async () => {
      await writeGlobal(`
defaults:
  provider: anthropic
  model: claude-sonnet-4.7
summariser:
  provider: anthropic
  model: claude-haiku-4.6
auto-title: true
`);
      await write(`
bootstrap: "bun install --frozen-lockfile"
defaults:
  model: claude-opus-4.7
`);
      const cfg = await load();
      expect(cfg.bootstrap).toBe("bun install --frozen-lockfile");
      expect(cfg.defaults?.provider).toBe("anthropic");
      expect(cfg.defaults?.model).toBe("claude-opus-4.7");
      expect(cfg.summariser?.model).toBe("claude-haiku-4.6");
      expect(cfg["auto-title"]).toBe(true);
    });

    test("rejects YAML root that is not a mapping", async () => {
      await write(`- item1\n- item2`);
      await expect(load()).rejects.toThrow(/must be a JSON object/);
    });
  });

  // ─── Legacy JSONC support (deprecation window) ──────────────────────

  describe("legacy JSONC support", () => {
    test("accepts comments and trailing commas (JSONC features)", async () => {
      await write(
        `{
      // pin model so the demo doesn't drift
      "defaults": {
        "provider": "ppq",
        "model": "claude-sonnet-4.6",
      },
    }`,
        "jsonc",
      );
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect((await load()).defaults?.provider).toBe("ppq");
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("throws on malformed JSONC (no silent fallback)", async () => {
      await write("{ this is not json }", "jsonc");
      await expect(load()).rejects.toThrow(/parse error/);
    });

    test("throws when the root is not an object (JSONC)", async () => {
      await write(`"just-a-string"`, "jsonc");
      await expect(load()).rejects.toThrow(/must be a JSON object/);
    });

    test("throws on schema violation in JSONC (typo'd key)", async () => {
      await write(`{ "autoTitler": true }`, "jsonc");
      await expect(load()).rejects.toThrow(/validation failed/);
    });

    test("throws on snake_case key from the legacy YAML schema (in JSONC)", async () => {
      await write(`{ "auto_title": true }`, "jsonc");
      await expect(load()).rejects.toThrow(/validation failed/);
    });

    test("global → project cascade works with JSONC files", async () => {
      await writeGlobal(`{ "auto-title": true, "blocklist": ["sudo "] }`, "jsonc");
      await write(`{ "bootstrap": "pnpm install --frozen-lockfile" }`, "jsonc");
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const cfg = await load();
        expect(cfg.bootstrap).toBe("pnpm install --frozen-lockfile");
        expect(cfg["auto-title"]).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});

describe("loadProjectConfig", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-projectconfig-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("returns {} when the project config is absent", async () => {
    expect(await loadProjectConfig(scratch)).toEqual({});
  });

  test("ignores the global config — local-only by design", async () => {
    expect(await loadProjectConfig(scratch)).toEqual({});
  });

  test("reads <cwd>/.swarm/config.yaml verbatim", async () => {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(join(scratch, ".swarm/config.yaml"), `bootstrap: "pnpm install --frozen-lockfile"`, "utf8");
    const cfg = await loadProjectConfig(scratch);
    expect(cfg.bootstrap).toBe("pnpm install --frozen-lockfile");
  });

  test("reads <cwd>/.swarm/config.jsonc verbatim (legacy)", async () => {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(join(scratch, ".swarm/config.jsonc"), `{ "bootstrap": "pnpm install --frozen-lockfile" }`, "utf8");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cfg = await loadProjectConfig(scratch);
      expect(cfg.bootstrap).toBe("pnpm install --frozen-lockfile");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("YAML wins over JSONC in the project layer", async () => {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(join(scratch, ".swarm/config.yaml"), `bootstrap: "yaml-bootstrap"`, "utf8");
    await writeFile(join(scratch, ".swarm/config.jsonc"), `{ "bootstrap": "jsonc-bootstrap" }`, "utf8");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cfg = await loadProjectConfig(scratch);
      expect(cfg.bootstrap).toBe("yaml-bootstrap");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("propagates parse + validation errors (no silent fallback)", async () => {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(join(scratch, ".swarm/config.yaml"), `bootstrap: 123`, "utf8");
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
        llm: "30m",
        tool: "5m",
        bootstrap: 600_000,
        shell: "30s",
        http: "30s",
        "leak-grace": "10s",
        "shutdown-drain": "30s",
      },
    });
    expect(r.llm).toBe(30 * 60 * 1000);
    expect(r.tool).toBe(5 * 60 * 1000);
    expect(r.bootstrap).toBe(600_000);
    expect(r.shell).toBe(30_000);
    expect(r.http).toBe(30_000);
    expect(r.leakGrace).toBe(10_000);
    expect(r.shutdownDrain).toBe(30_000);
  });

  test("reads leak-grace + shutdown-drain from the kebab source keys", () => {
    const r = resolveTimeouts({
      timeouts: { "leak-grace": "10s", "shutdown-drain": "30s" },
    });
    expect(r.leakGrace).toBe(10_000);
    expect(r.shutdownDrain).toBe(30_000);
  });

  test("invalid value throws with config-prefixed message", () => {
    expect(() => resolveTimeouts({ timeouts: { llm: "garbage" } })).toThrow(/config: timeouts\.llm:/);
  });

  test("invalid leak-grace throws with config-prefixed message including source key", () => {
    expect(() => resolveTimeouts({ timeouts: { "leak-grace": "bad" } })).toThrow(/config: timeouts\.leak-grace:/);
  });

  test("unset keys stay undefined (caller falls through to handler defaults)", () => {
    const r = resolveTimeouts({ timeouts: { llm: "10m" } });
    expect(r.llm).toBe(10 * 60 * 1000);
    expect(r.tool).toBeUndefined();
    expect(r.http).toBeUndefined();
  });

  test("property — any valid duration string round-trips", () => {
    const validDuration = fc
      .tuple(fc.integer({ min: 1, max: 10_000 }), fc.constantFrom("ms", "s", "m", "h"))
      .map(([n, u]) => [`${n}${u}`, n * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[u] ?? 1)] as const);
    fc.assert(
      fc.property(validDuration, ([input, expected]) => {
        expect(resolveTimeouts({ timeouts: { llm: input } }).llm).toBe(expected);
      }),
    );
  });

  test("property — any invalid value surfaces a config-prefixed error", () => {
    // "0" / "0s" / integer 0 are no longer invalid — parseDurationMs accepts
    // them as the unbounded sentinel (docs/proposals/llm-unbounded-time.md).
    // Negative numbers and malformed strings still throw.
    const badValue = fc.oneof(
      fc.constantFrom("garbage", "", "   ", "-1", "5x", "1.5m"),
      fc.integer({ min: -1_000, max: -1 }),
    );
    fc.assert(
      fc.property(badValue, (v) => {
        expect(() => resolveTimeouts({ timeouts: { llm: v as string | number } })).toThrow(/config: timeouts\./);
      }),
    );
  });
});
