// Store-backed `ModelRegistry.loadCustomModels` — exercises the
// per-row Ajv validation contract from
// docs/proposals/provider-config-storage.md.

import { describe, expect, test } from "bun:test";
import { SqliteStore } from "@swarm/store";
import { AuthStorage, ModelRegistry } from "../src/index.ts";

function freshStore(): SqliteStore {
  return new SqliteStore();
}

describe("ModelRegistry store-backed loadCustomModels", () => {
  test("seeded provider_config rows surface as custom models", () => {
    const store = freshStore();
    try {
      store.upsertProviderConfig({
        provider: "my-custom",
        config: JSON.stringify({
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          models: [
            {
              id: "llama3.1:8b",
              name: "llama3.1:8b",
              api: "openai-completions",
              contextWindow: 128_000,
              maxTokens: 8_192,
            },
          ],
        }),
      });

      const auth = AuthStorage.fromStore(store);
      const registry = ModelRegistry.create(auth, store);

      const found = registry.find("my-custom", "llama3.1:8b");
      expect(found).toBeDefined();
      expect(found!.baseUrl).toBe("http://localhost:11434/v1");
      // Per-row validation surfaced no errors for a well-formed row.
      expect(registry.getError()).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("Ajv failure on one row leaves sibling providers loaded", () => {
    const store = freshStore();
    try {
      // Valid row.
      store.upsertProviderConfig({
        provider: "good-provider",
        config: JSON.stringify({
          baseUrl: "https://api.good.example/v1",
          api: "openai-completions",
          models: [
            {
              id: "good-model",
              name: "good-model",
              api: "openai-completions",
              contextWindow: 32_000,
              maxTokens: 4_096,
            },
          ],
        }),
      });
      // Broken row \u2014 `compat` must be an object, not a number; Ajv
      // rejects.
      store.upsertProviderConfig({
        provider: "broken-provider",
        config: JSON.stringify({
          baseUrl: "https://api.broken.example/v1",
          api: "openai-completions",
          compat: 42,
          models: [{ id: "x", name: "x", api: "openai-completions", contextWindow: 1000, maxTokens: 100 }],
        }),
      });

      const auth = AuthStorage.fromStore(store);
      const registry = ModelRegistry.create(auth, store);

      // Sibling row still loaded.
      expect(registry.find("good-provider", "good-model")).toBeDefined();
      // Broken row was skipped.
      expect(registry.find("broken-provider", "x")).toBeUndefined();
      // loadError surfaces the broken provider's name so the operator
      // can find the row.
      const err = registry.getError();
      expect(err).toBeDefined();
      expect(err).toContain("broken-provider");
    } finally {
      store.close();
    }
  });

  test("refresh() re-reads from the store", () => {
    const store = freshStore();
    try {
      const auth = AuthStorage.fromStore(store);
      const registry = ModelRegistry.create(auth, store);
      expect(registry.find("late-provider", "m1")).toBeUndefined();

      // Insert after construction.
      store.upsertProviderConfig({
        provider: "late-provider",
        config: JSON.stringify({
          baseUrl: "https://late.example/v1",
          api: "openai-completions",
          models: [
            {
              id: "m1",
              name: "m1",
              api: "openai-completions",
              contextWindow: 16_000,
              maxTokens: 2_048,
            },
          ],
        }),
      });

      // Pre-refresh: stale view.
      expect(registry.find("late-provider", "m1")).toBeUndefined();
      // Post-refresh: row surfaces.
      registry.refresh();
      expect(registry.find("late-provider", "m1")).toBeDefined();
    } finally {
      store.close();
    }
  });
});
