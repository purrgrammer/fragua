// Unit tests for resolveBackoff — the resolution gap between the fully-implemented
// retry-policy reducer and the executor. These tests verify that node/graph attrs
// are correctly resolved to a BackoffConfig before the reducer sees them.

import { describe, expect, test } from "bun:test";
import type { GraphAttrs, NodeAttrs } from "@swarm/core";
import { RETRY_PRESETS } from "@swarm/core";
import { resolveBackoff } from "../src/executor.ts";

describe("resolveBackoff", () => {
  test("returns RETRY_PRESETS.none fields when no policy is set", () => {
    const cfg = resolveBackoff({} as NodeAttrs, {} as GraphAttrs);
    expect(cfg.initialDelayMs).toBe(RETRY_PRESETS.none.initialDelayMs);
    expect(cfg.backoffFactor).toBe(RETRY_PRESETS.none.backoffFactor);
    expect(cfg.maxDelayMs).toBe(RETRY_PRESETS.none.maxDelayMs);
    expect(cfg.jitter).toBe(RETRY_PRESETS.none.jitter);
  });

  test("returns RETRY_PRESETS.standard fields when node sets retry_policy=standard", () => {
    const cfg = resolveBackoff({ retry_policy: "standard" } as NodeAttrs, {} as GraphAttrs);
    expect(cfg.initialDelayMs).toBe(RETRY_PRESETS.standard.initialDelayMs);
    expect(cfg.backoffFactor).toBe(RETRY_PRESETS.standard.backoffFactor);
    expect(cfg.maxDelayMs).toBe(RETRY_PRESETS.standard.maxDelayMs);
    expect(cfg.jitter).toBe(RETRY_PRESETS.standard.jitter);
  });

  test("falls back to graph.default_retry_policy when node has no preset", () => {
    const cfg = resolveBackoff({} as NodeAttrs, { default_retry_policy: "aggressive" } as GraphAttrs);
    expect(cfg.initialDelayMs).toBe(RETRY_PRESETS.aggressive.initialDelayMs);
    expect(cfg.backoffFactor).toBe(RETRY_PRESETS.aggressive.backoffFactor);
  });

  test("node retry_policy takes precedence over graph default_retry_policy", () => {
    const cfg = resolveBackoff(
      { retry_policy: "linear" } as NodeAttrs,
      { default_retry_policy: "aggressive" } as GraphAttrs,
    );
    expect(cfg.initialDelayMs).toBe(RETRY_PRESETS.linear.initialDelayMs);
    expect(cfg.maxDelayMs).toBe(RETRY_PRESETS.linear.maxDelayMs);
  });

  test("per-node overrides replace individual fields of the resolved preset", () => {
    const cfg = resolveBackoff(
      {
        retry_policy: "standard",
        retry_initial_delay_ms: 50,
      } as NodeAttrs,
      {} as GraphAttrs,
    );
    expect(cfg.initialDelayMs).toBe(50);
    expect(cfg.backoffFactor).toBe(RETRY_PRESETS.standard.backoffFactor);
    expect(cfg.maxDelayMs).toBe(RETRY_PRESETS.standard.maxDelayMs);
    expect(cfg.jitter).toBe(RETRY_PRESETS.standard.jitter);
  });

  test("all four per-node overrides replace their respective fields", () => {
    const cfg = resolveBackoff(
      {
        retry_policy: "standard",
        retry_initial_delay_ms: 100,
        retry_backoff_factor: 1.5,
        retry_max_delay_ms: 10_000,
        retry_jitter: false,
      } as NodeAttrs,
      {} as GraphAttrs,
    );
    expect(cfg.initialDelayMs).toBe(100);
    expect(cfg.backoffFactor).toBe(1.5);
    expect(cfg.maxDelayMs).toBe(10_000);
    expect(cfg.jitter).toBe(false);
  });

  test("unknown preset name silently falls back to none", () => {
    const cfg = resolveBackoff({ retry_policy: "nonexistent" as never } as NodeAttrs, {} as GraphAttrs);
    expect(cfg.initialDelayMs).toBe(0);
    expect(cfg.jitter).toBe(false);
  });

  test("returns all five named presets correctly", () => {
    for (const [name, preset] of Object.entries(RETRY_PRESETS)) {
      const cfg = resolveBackoff({ retry_policy: name as never } as NodeAttrs, {} as GraphAttrs);
      expect(cfg.initialDelayMs).toBe(preset.initialDelayMs);
      expect(cfg.backoffFactor).toBe(preset.backoffFactor);
      expect(cfg.maxDelayMs).toBe(preset.maxDelayMs);
      expect(cfg.jitter).toBe(preset.jitter);
    }
  });
});
