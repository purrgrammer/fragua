// Tests for .swarm/config.jsonc loading. Missing file returns `{}`
// for first-run UX. Malformed JSONC and schema-invalid content throw
// — silent fallback would hide typos that mis-route runs.

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

  async function write(body: string): Promise<void> {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(join(scratch, ".swarm/config.jsonc"), body, "utf8");
  }

  test("returns {} when .swarm/config.jsonc is missing", async () => {
    const cfg = await loadConfig(scratch);
    expect(cfg).toEqual({});
  });

  test("parses defaults.provider and defaults.model", async () => {
    await write(`{
      "defaults": {
        "provider": "openrouter",
        "model": "anthropic/claude-opus-4.7"
      }
    }`);
    const cfg = await loadConfig(scratch);
    expect(cfg.defaults?.provider).toBe("openrouter");
    expect(cfg.defaults?.model).toBe("anthropic/claude-opus-4.7");
  });

  test("accepts comments and trailing commas (JSONC features)", async () => {
    await write(`{
      // pin model so the demo doesn't drift
      "defaults": {
        "provider": "ppq",
        "model": "claude-sonnet-4.6",
      },
    }`);
    const cfg = await loadConfig(scratch);
    expect(cfg.defaults?.provider).toBe("ppq");
  });

  test("throws on malformed JSONC (no silent fallback)", async () => {
    await write("{ this is not json }");
    await expect(loadConfig(scratch)).rejects.toThrow(/parse error/);
  });

  test("throws when the root is not an object", async () => {
    await write(`"just-a-string"`);
    await expect(loadConfig(scratch)).rejects.toThrow(/must be a JSON object/);
  });

  test("throws on schema violation (typo'd key)", async () => {
    await write(`{ "autoTitler": true }`);
    await expect(loadConfig(scratch)).rejects.toThrow(/validation failed/);
  });

  test("throws on snake_case key from the legacy YAML schema", async () => {
    await write(`{ "auto_title": true }`);
    await expect(loadConfig(scratch)).rejects.toThrow(/validation failed/);
  });

  test("parses runtime ceilings: maxQueuedRuns, abortLoopCeiling, maxLeakedHandlers", async () => {
    await write(`{
      "maxQueuedRuns": 500,
      "abortLoopCeiling": 8,
      "maxLeakedHandlers": 2
    }`);
    const cfg = await loadConfig(scratch);
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
    const cfg = await loadConfig(scratch);
    expect(cfg.timeouts?.codergen).toBe("30m");
    expect(cfg.timeouts?.tool).toBe("5m");
    expect(cfg.timeouts?.http).toBe("30s");
    expect(cfg.timeouts?.leakGrace).toBe("10s");
    expect(cfg.timeouts?.shutdownDrain).toBe("30s");
  });

  test("parses identity (id + name) when present", async () => {
    await write(`{
      "version": 1,
      "id": "019de01e-5ccd-7010-9184-defb237e74db",
      "name": "demo"
    }`);
    const cfg = await loadConfig(scratch);
    expect(cfg.id).toBe("019de01e-5ccd-7010-9184-defb237e74db");
    expect(cfg.name).toBe("demo");
  });

  test("rejects ids that are not UUIDv7", async () => {
    await write(`{ "id": "00000000-0000-4000-8000-000000000000" }`);
    await expect(loadConfig(scratch)).rejects.toThrow(/validation failed/);
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
