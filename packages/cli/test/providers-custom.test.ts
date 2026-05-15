// Pure-function tests for providers-custom helpers, plus a small
// integration test that exercises the store-write path. The wizard's
// prompts UI is not under test \u2014 it never was.

import { describe, expect, test } from "bun:test";
import { SqliteStore } from "@swarm/store";
import {
  buildModelEntry,
  buildProviderEntry,
  type CustomProviderAnswers,
  inferModelDefaults,
  mergeProviderEntry,
  type ProviderEntry,
  validateBaseUrl,
  validateModelId,
  validateProviderName,
} from "../src/commands/providers-custom.ts";

// ---------------------------------------------------------------------------
// validateProviderName
// ---------------------------------------------------------------------------
describe("validateProviderName", () => {
  test("accepts simple slug", () => {
    expect(validateProviderName("ollama")).toBe(true);
  });
  test("accepts hyphens and underscores", () => {
    expect(validateProviderName("my-provider_v2")).toBe(true);
  });
  test("rejects empty string", () => {
    expect(typeof validateProviderName("")).toBe("string");
  });
  test("rejects whitespace-only", () => {
    expect(typeof validateProviderName("   ")).toBe("string");
  });
  test("rejects spaces inside", () => {
    expect(typeof validateProviderName("my provider")).toBe("string");
  });
  test("rejects special chars", () => {
    expect(typeof validateProviderName("my/provider")).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// validateBaseUrl
// ---------------------------------------------------------------------------
describe("validateBaseUrl", () => {
  test("accepts http", () => {
    expect(validateBaseUrl("http://localhost:11434/v1")).toBe(true);
  });
  test("accepts https", () => {
    expect(validateBaseUrl("https://api.example.com/v1")).toBe(true);
  });
  test("rejects empty", () => {
    expect(typeof validateBaseUrl("")).toBe("string");
  });
  test("rejects non-url", () => {
    expect(typeof validateBaseUrl("not a url")).toBe("string");
  });
  test("rejects ftp", () => {
    expect(typeof validateBaseUrl("ftp://example.com")).toBe("string");
  });
  test("rejects bare hostname without protocol", () => {
    expect(typeof validateBaseUrl("localhost:11434")).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// validateModelId
// ---------------------------------------------------------------------------
describe("validateModelId", () => {
  test("accepts simple id", () => {
    expect(validateModelId("llama3.1:8b")).toBe(true);
  });
  test("accepts slash-namespaced id", () => {
    expect(validateModelId("anthropic/claude-3-haiku")).toBe(true);
  });
  test("rejects empty", () => {
    expect(typeof validateModelId("")).toBe("string");
  });
  test("rejects whitespace-only", () => {
    expect(typeof validateModelId("  ")).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// inferModelDefaults
// ---------------------------------------------------------------------------
describe("inferModelDefaults", () => {
  test("llama3.1:8b gets 128k context", () => {
    const d = inferModelDefaults("llama3.1:8b");
    expect(d.contextWindow).toBe(128_000);
    expect(d.maxTokens).toBe(8_192);
  });
  test("llama2:7b gets 4k context", () => {
    const d = inferModelDefaults("llama2:7b");
    expect(d.contextWindow).toBe(4_096);
    expect(d.maxTokens).toBe(2_048);
  });
  test("mistral:7b gets 32k context", () => {
    const d = inferModelDefaults("mistral:7b");
    expect(d.contextWindow).toBe(32_768);
    expect(d.maxTokens).toBe(8_192);
  });
  test("unknown model gets conservative fallback", () => {
    const d = inferModelDefaults("gpt-4o-mini");
    expect(d.contextWindow).toBe(128_000);
    expect(d.maxTokens).toBe(16_384);
  });
  test("qwen2.5:14b gets 32k context", () => {
    const d = inferModelDefaults("qwen2.5:14b");
    expect(d.contextWindow).toBe(32_768);
  });
  test("gemma2:9b gets 8k context", () => {
    const d = inferModelDefaults("gemma2:9b");
    expect(d.contextWindow).toBe(8_192);
  });
});

// ---------------------------------------------------------------------------
// buildProviderEntry
// ---------------------------------------------------------------------------
describe("buildProviderEntry without apiKey", () => {
  const baseAnswers: CustomProviderAnswers = {
    providerName: "ollama",
    baseUrl: "http://localhost:11434/v1",
    api: "openai-completions",
    modelIds: ["llama3.1:8b"],
  };

  test("builds entry with one model", () => {
    const entry = buildProviderEntry(baseAnswers);
    expect(entry.baseUrl).toBe("http://localhost:11434/v1");
    expect(entry.api).toBe("openai-completions");
    expect(entry.models).toHaveLength(1);
    expect(entry.models[0]!.id).toBe("llama3.1:8b");
  });

  test("does not emit an apiKey field", () => {
    const entry = buildProviderEntry(baseAnswers);
    expect(JSON.stringify(entry).includes("apiKey")).toBe(false);
    expect((entry as unknown as Record<string, unknown>)["apiKey"]).toBeUndefined();
  });

  test("each model gets its own context-window heuristic", () => {
    const entry = buildProviderEntry({
      ...baseAnswers,
      modelIds: ["llama3.1:8b", "mistral:7b"],
    });
    expect(entry.models).toHaveLength(2);
    expect(entry.models[0]!.contextWindow).toBe(128_000); // llama3
    expect(entry.models[1]!.contextWindow).toBe(32_768); // mistral
  });

  test("trims model id whitespace", () => {
    const entry = buildProviderEntry({ ...baseAnswers, modelIds: ["  llama3.1:8b  "] });
    expect(entry.models[0]!.id).toBe("llama3.1:8b");
  });

  test("uses openai-responses api correctly", () => {
    const entry = buildProviderEntry({ ...baseAnswers, api: "openai-responses" });
    expect(entry.api).toBe("openai-responses");
    expect(entry.models[0]!.api).toBe("openai-responses");
  });
});

// ---------------------------------------------------------------------------
// mergeProviderEntry
// ---------------------------------------------------------------------------
describe("mergeProviderEntry", () => {
  const existing: ProviderEntry = {
    baseUrl: "http://localhost:11434/v1",
    api: "openai-completions",
    models: [buildModelEntry({ id: "llama3.1:8b", api: "openai-completions" })],
  };

  const newEntry: ProviderEntry = {
    baseUrl: "http://localhost:11434/v1",
    api: "openai-completions",
    models: [buildModelEntry({ id: "mistral:7b", api: "openai-completions" })],
  };

  test("overwrite=true replaces provider entirely", () => {
    const result = mergeProviderEntry(existing, newEntry, true);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]!.id).toBe("mistral:7b");
  });

  test("overwrite=false merges model lists", () => {
    const result = mergeProviderEntry(existing, newEntry, false);
    expect(result.models).toHaveLength(2);
    const ids = result.models.map((m) => m.id);
    expect(ids).toContain("llama3.1:8b");
    expect(ids).toContain("mistral:7b");
  });

  test("merge updates a model with a duplicate id", () => {
    const updated: ProviderEntry = {
      ...newEntry,
      models: [
        buildModelEntry({
          id: "llama3.1:8b",
          api: "openai-completions",
          name: "llama3.1 updated",
          contextWindow: 200_000,
          maxTokens: 16_384,
        }),
      ],
    };
    const result = mergeProviderEntry(existing, updated, false);
    const m = result.models.find((m) => m.id === "llama3.1:8b");
    expect(m?.name).toBe("llama3.1 updated");
    expect(m?.contextWindow).toBe(200_000);
  });

  test("does not mutate the original entry", () => {
    const snapshot = JSON.stringify(existing);
    mergeProviderEntry(existing, newEntry, false);
    expect(JSON.stringify(existing)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// buildModelEntry (flag overrides)
// ---------------------------------------------------------------------------
describe("buildModelEntry (flag overrides)", () => {
  test("flag-set fields override the inferModelDefaults heuristic", () => {
    const m = buildModelEntry({ id: "llama3.1:8b", contextWindow: 50 });
    // override wins over the llama3 heuristic (128_000)
    expect(m.contextWindow).toBe(50);
    // maxTokens un-overridden → inherits the heuristic (8_192)
    expect(m.maxTokens).toBe(8_192);
  });

  test("field-zero defaults fill in when no overrides supplied", () => {
    const m = buildModelEntry({ id: "some-model" });
    expect(m.reasoning).toBe(false);
    expect(m.input).toEqual(["text"]);
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(m.name).toBe("some-model");
  });
});

// ---------------------------------------------------------------------------
// Integration: writes a provider_config row
// ---------------------------------------------------------------------------
describe("providers add --custom writes a provider_config row", () => {
  test("upsert lands the JSON body under the provider id", () => {
    const store = new SqliteStore();
    try {
      const entry = buildProviderEntry({
        providerName: "ollama",
        baseUrl: "http://localhost:11434/v1",
        api: "openai-completions",
        modelIds: ["llama3.1:8b"],
      });
      store.upsertProviderConfig({ provider: "ollama", config: JSON.stringify(entry) });

      const row = store.getProviderConfig("ollama");
      expect(row).not.toBeNull();
      expect(row!.config).toEqual(entry as unknown as Record<string, unknown>);
      const cfg = row!.config as ProviderEntry;
      expect(cfg.baseUrl).toBe("http://localhost:11434/v1");
      expect(cfg.models[0]!.id).toBe("llama3.1:8b");
      // No apiKey field landed.
      expect((cfg as unknown as Record<string, unknown>)["apiKey"]).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
