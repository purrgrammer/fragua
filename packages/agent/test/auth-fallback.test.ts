// AuthStorage no longer resolves custom-provider keys from a separate
// models.json fallback resolver. After the provider-config-storage
// proposal landed, credentials always come from the
// `provider_credentials` table for built-ins and custom providers
// alike, and `provider_config` rows carry only the definition (no
// `apiKey` field).
//
// These tests pin the contract:
//   1. A custom provider with no `provider_credentials` row reports
//      `hasAuth = false` and a null `describeAuthSource`.
//   2. Adding an api_key row makes the same provider report
//      `hasAuth = true`, `describeAuthSource === "stored api_key"`,
//      and `getApiKey` returns the stored key verbatim.

import { describe, expect, test } from "bun:test";
import { SqliteStore } from "@swarm/store";
import { AuthStorage, ModelRegistry } from "../src/index.ts";

describe("AuthStorage no longer resolves custom-provider keys", () => {
  test("hasAuth false for a custom provider with no credential row", () => {
    const auth = AuthStorage.inMemory({});
    const registry = ModelRegistry.inMemory(auth);

    // A custom provider definition lives in code via registerProvider
    // (or, in production, in `provider_config`). Either way, no
    // credential row exists yet.
    registry.registerProvider("ppq-test", {
      baseUrl: "https://api.example.test",
      api: "openai-completions",
      models: [
        {
          id: "auto",
          name: "Auto",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 8_192,
        },
      ],
    });

    expect(auth.hasAuth("ppq-test")).toBe(false);
    expect(auth.describeAuthSource("ppq-test")).toBeNull();
    // The legacy "models.json custom provider" label must not surface.
    expect(auth.describeAuthSource("ppq-test")).not.toBe("models.json custom provider");
  });

  test("hasAuth true once a credential is added via the store", async () => {
    const store = new SqliteStore();
    try {
      store.upsertProviderCredential({
        provider: "ppq-test",
        kind: "api_key",
        payload: JSON.stringify({ type: "api_key", key: "sk-stored-key" }),
      });
      const auth = AuthStorage.fromStore(store);
      // Tie the registry to the store too so the custom-provider
      // definition path is the integration shape.
      const registry = ModelRegistry.create(auth, store);
      registry.registerProvider("ppq-test", {
        baseUrl: "https://api.example.test",
        api: "openai-completions",
        models: [
          {
            id: "auto",
            name: "Auto",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 100_000,
            maxTokens: 8_192,
          },
        ],
      });

      expect(auth.hasAuth("ppq-test")).toBe(true);
      expect(auth.describeAuthSource("ppq-test")).toBe("stored api_key");
      expect(await auth.getApiKey("ppq-test")).toBe("sk-stored-key");
    } finally {
      store.close();
    }
  });

  test("unknown provider returns null/undefined", async () => {
    const auth = AuthStorage.inMemory({});
    ModelRegistry.inMemory(auth);
    expect(auth.hasAuth("never-configured")).toBe(false);
    expect(auth.describeAuthSource("never-configured")).toBeNull();
    expect(await auth.getApiKey("never-configured")).toBeUndefined();
  });
});
