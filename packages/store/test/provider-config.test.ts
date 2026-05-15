// Tests for the `provider_config` store API
// (docs/proposals/provider-config-storage.md).

import { describe, expect, test } from "bun:test";
import { SqliteStore } from "../src/store.ts";

function freshStore(): SqliteStore {
  return new SqliteStore();
}

describe("provider_config store API", () => {
  test("upsert + get round-trips a provider config blob", () => {
    const store = freshStore();
    try {
      const body = {
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
      };
      store.upsertProviderConfig({ provider: "ollama", config: JSON.stringify(body) });

      const got = store.getProviderConfig("ollama");
      expect(got).not.toBeNull();
      expect(got!.provider).toBe("ollama");
      expect(got!.config).toEqual(body);
      expect(typeof got!.createdAt).toBe("number");
      expect(typeof got!.updatedAt).toBe("number");
    } finally {
      store.close();
    }
  });

  test("upsert preserves created_at on conflict", () => {
    let nowValue = 1_000;
    const store = new SqliteStore({ now: () => nowValue });
    try {
      store.upsertProviderConfig({
        provider: "ppq",
        config: JSON.stringify({ baseUrl: "https://a.example", models: [] }),
      });
      const first = store.getProviderConfig("ppq")!;

      nowValue = 2_500;
      store.upsertProviderConfig({
        provider: "ppq",
        config: JSON.stringify({ baseUrl: "https://b.example", models: [] }),
      });

      const second = store.getProviderConfig("ppq")!;
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
      expect((second.config as { baseUrl: string }).baseUrl).toBe("https://b.example");
    } finally {
      store.close();
    }
  });

  test("listProviderConfigs returns rows ordered by provider ASC", () => {
    const store = freshStore();
    try {
      store.upsertProviderConfig({ provider: "openai-proxy", config: JSON.stringify({ baseUrl: "https://o" }) });
      store.upsertProviderConfig({ provider: "anthropic-proxy", config: JSON.stringify({ baseUrl: "https://a" }) });
      store.upsertProviderConfig({ provider: "groq-proxy", config: JSON.stringify({ baseUrl: "https://g" }) });

      const list = store.listProviderConfigs();
      expect(list.map((r) => r.provider)).toEqual(["anthropic-proxy", "groq-proxy", "openai-proxy"]);
    } finally {
      store.close();
    }
  });

  test("deleteProviderConfig is idempotent", () => {
    const store = freshStore();
    try {
      store.upsertProviderConfig({ provider: "tmp", config: JSON.stringify({ baseUrl: "x" }) });
      expect(store.getProviderConfig("tmp")).not.toBeNull();

      store.deleteProviderConfig("tmp");
      expect(store.getProviderConfig("tmp")).toBeNull();

      // Second delete must not throw.
      store.deleteProviderConfig("tmp");
      expect(store.getProviderConfig("tmp")).toBeNull();
    } finally {
      store.close();
    }
  });
});
