// Tests for resolveModelOrNull — the pre-flight check that saves us from
// runaway retry loops when (provider, model) doesn't resolve.

import { describe, expect, test } from "bun:test";
import { defaultModelFor, getProviderInfo, KNOWN_PROVIDERS, resolveModelOrNull } from "../src/providers.ts";

describe("resolveModelOrNull — pre-flight model resolution", () => {
  test("returns the model for a valid (provider, model) pair", () => {
    const m = resolveModelOrNull("anthropic", "claude-haiku-4-5");
    expect(m).not.toBeNull();
  });

  test("returns null for an unregistered model on a known provider", () => {
    const m = resolveModelOrNull("anthropic", "claude-does-not-exist");
    expect(m).toBeNull();
  });

  test("returns null for an unknown provider", () => {
    const m = resolveModelOrNull("does-not-exist", "some-model");
    expect(m).toBeNull();
  });

  test("catches the classic bug: anthropic model id on openrouter", () => {
    // `claude-haiku-4-5` is a direct-anthropic id; on openrouter it's `anthropic/claude-haiku-4.5`
    expect(resolveModelOrNull("openrouter", "claude-haiku-4-5")).toBeNull();
    // With the correct namespace, it resolves:
    expect(resolveModelOrNull("openrouter", "anthropic/claude-haiku-4.5")).not.toBeNull();
  });
});

describe("defaultModelFor — per-provider default", () => {
  test("returns a valid model id for each known provider", () => {
    const info = getProviderInfo("anthropic");
    expect(info?.defaultModel).toBe("claude-opus-4-7");

    const router = getProviderInfo("openrouter");
    expect(router?.defaultModel).toBe("anthropic/claude-opus-4.7");

    // Every provider's defaultModel + every exampleModels entry must resolve
    // in pi-ai. This is the invariant that prevents runaway retry loops when
    // the user passes --provider without --model.
    for (const p of KNOWN_PROVIDERS) {
      if (p.defaultModel) {
        const m = resolveModelOrNull(p.name, p.defaultModel);
        expect(m, `provider "${p.name}" default model "${p.defaultModel}" does not resolve in pi-ai`).not.toBeNull();
      }
      for (const ex of p.exampleModels ?? []) {
        const m = resolveModelOrNull(p.name, ex);
        expect(m, `provider "${p.name}" example model "${ex}" does not resolve in pi-ai`).not.toBeNull();
      }
    }
  });

  test("defaultModelFor returns undefined for unknown providers", () => {
    expect(defaultModelFor("nonexistent")).toBeUndefined();
  });
});
