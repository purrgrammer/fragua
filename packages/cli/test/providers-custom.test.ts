// Pure-function tests for providers-custom helpers.
// No prompts, no fs, no network — all I/O is exercised through the
// helper functions that are separately unit-testable.

import { describe, expect, test } from "bun:test";
import {
  buildProviderEntry,
  type CustomProviderAnswers,
  inferModelDefaults,
  type ModelsJson,
  mergeProviderEntry,
  type ProviderEntry,
  parseModelsJson,
  serialiseModelsJson,
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
// parseModelsJson
// ---------------------------------------------------------------------------
describe("parseModelsJson", () => {
  test("parses valid empty providers object", () => {
    const result = parseModelsJson('{"providers":{}}');
    expect(typeof result).toBe("object");
    expect((result as ModelsJson).providers).toEqual({});
  });
  test("parses file with a provider entry", () => {
    const input = JSON.stringify({
      providers: {
        ollama: {
          baseUrl: "http://localhost:11434/v1",
          api: "openai_completions",
          apiKey: "",
          models: [{ id: "llama3.1:8b", name: "llama3.1:8b", api: "openai_completions" }],
        },
      },
    });
    const result = parseModelsJson(input);
    expect(typeof result).not.toBe("string");
    expect((result as ModelsJson).providers["ollama"]).toBeDefined();
  });
  test("returns string on invalid JSON", () => {
    const result = parseModelsJson("not json");
    expect(typeof result).toBe("string");
  });
  test("returns string when root is an array", () => {
    const result = parseModelsJson("[]");
    expect(typeof result).toBe("string");
  });
  test("returns string when providers is an array", () => {
    const result = parseModelsJson('{"providers":[]}');
    expect(typeof result).toBe("string");
  });
  test("accepts missing providers key (treats as empty)", () => {
    const result = parseModelsJson("{}");
    expect(typeof result).toBe("object");
    expect((result as ModelsJson).providers).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// serialiseModelsJson
// ---------------------------------------------------------------------------
describe("serialiseModelsJson", () => {
  test("round-trips through parseModelsJson", () => {
    const original: ModelsJson = {
      providers: {
        ollama: {
          baseUrl: "http://localhost:11434/v1",
          api: "openai_completions",
          apiKey: "",
          models: [{ id: "llama3.1:8b", name: "llama3.1:8b", api: "openai_completions" }],
        },
      },
    };
    const serialised = serialiseModelsJson(original);
    const reparsed = parseModelsJson(serialised);
    expect(typeof reparsed).toBe("object");
    expect((reparsed as ModelsJson).providers["ollama"]?.baseUrl).toBe("http://localhost:11434/v1");
  });
  test("ends with newline", () => {
    const out = serialiseModelsJson({ providers: {} });
    expect(out.endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildProviderEntry
// ---------------------------------------------------------------------------
describe("buildProviderEntry", () => {
  const baseAnswers: CustomProviderAnswers = {
    providerName: "ollama",
    baseUrl: "http://localhost:11434/v1",
    apiKeyField: undefined,
    api: "openai_completions",
    modelIds: ["llama3.1:8b"],
  };

  test("builds entry with one model", () => {
    const entry = buildProviderEntry(baseAnswers);
    expect(entry.baseUrl).toBe("http://localhost:11434/v1");
    expect(entry.api).toBe("openai_completions");
    expect(entry.models).toHaveLength(1);
    expect(entry.models[0]!.id).toBe("llama3.1:8b");
  });

  test("sets apiKey to empty string when no auth", () => {
    const entry = buildProviderEntry(baseAnswers);
    expect(entry.apiKey).toBe("");
  });

  test("sets apiKey to literal value when provided", () => {
    const entry = buildProviderEntry({ ...baseAnswers, apiKeyField: "sk-secret" });
    expect(entry.apiKey).toBe("sk-secret");
  });

  test("sets apiKey to env-var name when env form used", () => {
    const entry = buildProviderEntry({ ...baseAnswers, apiKeyField: "OLLAMA_API_KEY" });
    expect(entry.apiKey).toBe("OLLAMA_API_KEY");
  });

  test("sets apiKey to !cmd when shell form used", () => {
    const entry = buildProviderEntry({ ...baseAnswers, apiKeyField: "!op read 'op://vault/item/key'" });
    expect(entry.apiKey).toBe("!op read 'op://vault/item/key'");
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

  test("uses openai_responses api correctly", () => {
    const entry = buildProviderEntry({ ...baseAnswers, api: "openai_responses" });
    expect(entry.api).toBe("openai_responses");
    expect(entry.models[0]!.api).toBe("openai_responses");
  });
});

// ---------------------------------------------------------------------------
// mergeProviderEntry
// ---------------------------------------------------------------------------
describe("mergeProviderEntry", () => {
  const existing: ModelsJson = {
    providers: {
      ollama: {
        baseUrl: "http://localhost:11434/v1",
        api: "openai_completions",
        apiKey: "",
        models: [
          {
            id: "llama3.1:8b",
            name: "llama3.1:8b",
            api: "openai_completions",
            contextWindow: 128_000,
            maxTokens: 8_192,
          },
        ],
      },
    },
  };

  const newEntry: ProviderEntry = {
    baseUrl: "http://localhost:11434/v1",
    api: "openai_completions",
    apiKey: "",
    models: [
      { id: "mistral:7b", name: "mistral:7b", api: "openai_completions", contextWindow: 32_768, maxTokens: 8_192 },
    ],
  };

  test("overwrite=true replaces provider entirely", () => {
    const result = mergeProviderEntry(existing, "ollama", newEntry, true);
    expect(result.providers["ollama"]!.models).toHaveLength(1);
    expect(result.providers["ollama"]!.models[0]!.id).toBe("mistral:7b");
  });

  test("overwrite=false merges model lists", () => {
    const result = mergeProviderEntry(existing, "ollama", newEntry, false);
    expect(result.providers["ollama"]!.models).toHaveLength(2);
    const ids = result.providers["ollama"]!.models.map((m) => m.id);
    expect(ids).toContain("llama3.1:8b");
    expect(ids).toContain("mistral:7b");
  });

  test("merge updates model if id already exists", () => {
    const updatedModel: ProviderEntry = {
      ...newEntry,
      models: [
        {
          id: "llama3.1:8b",
          name: "llama3.1 updated",
          api: "openai_completions",
          contextWindow: 200_000,
          maxTokens: 16_384,
        },
      ],
    };
    const result = mergeProviderEntry(existing, "ollama", updatedModel, false);
    const m = result.providers["ollama"]!.models.find((m) => m.id === "llama3.1:8b");
    expect(m?.name).toBe("llama3.1 updated");
    expect(m?.contextWindow).toBe(200_000);
  });

  test("adds a brand-new provider to an empty ModelsJson", () => {
    const empty: ModelsJson = { providers: {} };
    const result = mergeProviderEntry(empty, "newprov", newEntry, false);
    expect(result.providers["newprov"]).toBeDefined();
    expect(result.providers["newprov"]!.models[0]!.id).toBe("mistral:7b");
  });

  test("does not mutate the original ModelsJson", () => {
    const snapshot = JSON.stringify(existing);
    mergeProviderEntry(existing, "ollama", newEntry, false);
    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  test("preserves unrelated providers", () => {
    const withTwo: ModelsJson = {
      providers: {
        ...existing.providers,
        openrouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "sk-or-xxx",
          models: [],
        },
      },
    };
    const result = mergeProviderEntry(withTwo, "ollama", newEntry, true);
    expect(result.providers["openrouter"]).toBeDefined();
  });
});
