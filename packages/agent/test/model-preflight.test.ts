// Pre-flight model resolution tests. Replaces the old providers.ts-
// based invariants (default model resolves, provider recognizes own
// models, openrouter catches id-with-hyphen vs dotted-id typo).

import { describe, expect, test } from "bun:test";
import { AuthStorage, defaultModelPerProvider, findByBareId, ModelRegistry } from "../src/index.ts";

function buildRegistry(): ModelRegistry {
  // No auth set — we're exercising the model catalogue, not credentialing.
  return ModelRegistry.inMemory(AuthStorage.inMemory({}));
}

describe("ModelRegistry.find — pre-flight model resolution", () => {
  const registry = buildRegistry();

  test("returns the model for a valid (provider, id) pair", () => {
    expect(registry.find("anthropic", "claude-haiku-4-5")).toBeDefined();
  });

  test("returns undefined for an unregistered model on a known provider", () => {
    expect(registry.find("anthropic", "claude-does-not-exist")).toBeUndefined();
  });

  test("returns undefined for an unknown provider", () => {
    expect(registry.find("does-not-exist", "some-model")).toBeUndefined();
  });

  test("catches the classic bug: anthropic model id on openrouter", () => {
    // Direct-anthropic form: hyphens (`claude-haiku-4-5`).
    // OpenRouter form: dotted (`anthropic/claude-haiku-4.5`).
    expect(registry.find("openrouter", "claude-haiku-4-5")).toBeUndefined();
    expect(registry.find("openrouter", "anthropic/claude-haiku-4.5")).toBeDefined();
  });
});

describe("defaultModelPerProvider invariants", () => {
  const registry = buildRegistry();

  test("every entry resolves in pi-ai's built-in registry", () => {
    for (const [provider, modelId] of Object.entries(defaultModelPerProvider)) {
      const m = registry.find(provider, modelId);
      expect(m, `provider "${provider}" default "${modelId}" does not resolve`).toBeDefined();
    }
  });
});

describe("findByBareId — lenient validator path", () => {
  const registry = buildRegistry();

  test("accepts a direct-form Anthropic id without a provider", () => {
    expect(findByBareId(registry, "claude-haiku-4-5")).toBeDefined();
  });

  test("rejects a nonsense id", () => {
    expect(findByBareId(registry, "not-a-real-model-anywhere")).toBeUndefined();
  });
});
