// AuthStorage's hasAuth / describeAuthSource / getApiKey chain reaches
// custom providers from models.json via the fallback resolver wired by
// ModelRegistry's constructor. Without that wire, a models.json-only
// provider (e.g. ppq via OpenAI-compatible baseUrl + literal apiKey)
// looks uncredentialed end-to-end even though the registry has the key.

import { describe, expect, test } from "bun:test";
import { AuthStorage, ModelRegistry } from "../src/index.ts";

describe("AuthStorage fallback wiring (custom providers from models.json)", () => {
  test("registerProvider populates AuthStorage's hasAuth + getApiKey for literal keys", async () => {
    const auth = AuthStorage.inMemory({});
    const registry = ModelRegistry.inMemory(auth);

    expect(auth.hasAuth("ppq-test")).toBe(false);
    expect(auth.describeAuthSource("ppq-test")).toBeNull();

    registry.registerProvider("ppq-test", {
      baseUrl: "https://api.example.test",
      api: "openai-completions",
      apiKey: "sk-literal-test-key",
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
    expect(auth.describeAuthSource("ppq-test")).toBe("models.json custom provider");
    expect(await auth.getApiKey("ppq-test")).toBe("sk-literal-test-key");
  });

  test("explicit auth.json entry takes precedence over models.json fallback", async () => {
    const auth = AuthStorage.inMemory({
      "shared-name": { type: "api_key", key: "from-auth-json" },
    });
    const registry = ModelRegistry.inMemory(auth);
    registry.registerProvider("shared-name", {
      baseUrl: "https://api.example.test",
      api: "openai-completions",
      apiKey: "from-models-json",
      models: [
        {
          id: "m",
          name: "m",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000,
          maxTokens: 100,
        },
      ],
    });

    expect(await auth.getApiKey("shared-name")).toBe("from-auth-json");
  });

  test("unknown provider still returns null/undefined", async () => {
    const auth = AuthStorage.inMemory({});
    ModelRegistry.inMemory(auth);
    expect(auth.hasAuth("never-configured")).toBe(false);
    expect(auth.describeAuthSource("never-configured")).toBeNull();
    expect(await auth.getApiKey("never-configured")).toBeUndefined();
  });
});
