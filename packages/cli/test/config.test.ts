// Tests for .swarm/config.yaml loading. Config is always optional; missing or
// malformed files return `{}` rather than throwing so first-run UX is smooth.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { loadConfig, resolveTimeouts } from "../src/config.ts";

describe("loadConfig", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-config-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("returns {} when .swarm/config.yaml is missing", async () => {
    const cfg = await loadConfig(scratch);
    expect(cfg).toEqual({});
  });

  test("parses defaults.provider and defaults.model", async () => {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(
      join(scratch, ".swarm/config.yaml"),
      `defaults:\n  provider: openrouter\n  model: anthropic/claude-opus-4.7\n`,
      "utf8",
    );
    const cfg = await loadConfig(scratch);
    expect(cfg.defaults?.provider).toBe("openrouter");
    expect(cfg.defaults?.model).toBe("anthropic/claude-opus-4.7");
  });

  test("returns {} on malformed YAML (never throws)", async () => {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(join(scratch, ".swarm/config.yaml"), ": : not yaml : :", "utf8");
    const cfg = await loadConfig(scratch);
    expect(cfg).toEqual({});
  });

  test("returns {} when file parses to a non-object (e.g. just a string)", async () => {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(join(scratch, ".swarm/config.yaml"), "just-a-string", "utf8");
    const cfg = await loadConfig(scratch);
    expect(cfg).toEqual({});
  });

  test("parses runtime ceilings: max_queued_runs, abort_loop_ceiling, max_leaked_handlers", async () => {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(
      join(scratch, ".swarm/config.yaml"),
      `max_queued_runs: 500\nabort_loop_ceiling: 8\nmax_leaked_handlers: 2\n`,
      "utf8",
    );
    const cfg = await loadConfig(scratch);
    expect(cfg.max_queued_runs).toBe(500);
    expect(cfg.abort_loop_ceiling).toBe(8);
    expect(cfg.max_leaked_handlers).toBe(2);
  });

  test("parses the timeouts section", async () => {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(
      join(scratch, ".swarm/config.yaml"),
      `timeouts:\n  codergen: 30m\n  tool: "5m"\n  http: 30s\n  leak_grace: 10s\n`,
      "utf8",
    );
    const cfg = await loadConfig(scratch);
    expect(cfg.timeouts?.codergen).toBe("30m");
    expect(cfg.timeouts?.tool).toBe("5m");
    expect(cfg.timeouts?.http).toBe("30s");
    expect(cfg.timeouts?.leak_grace).toBe("10s");
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
        leak_grace: "10s",
        shutdown_drain: "30s",
      },
    });
    expect(r.codergen).toBe(30 * 60 * 1000);
    expect(r.tool).toBe(5 * 60 * 1000);
    expect(r.bootstrap).toBe(600_000);
    expect(r.shell).toBe(30_000);
    expect(r.http).toBe(30_000);
    expect(r.leak_grace).toBe(10_000);
    expect(r.shutdown_drain).toBe(30_000);
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
