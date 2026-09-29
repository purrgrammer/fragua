// Judge provider records read from `provider_config` under the `judge:` key
// prefix, and the prefix's other job: keeping those rows out of the llm
// registry, which would otherwise adopt them silently.

import { describe, expect, test } from "bun:test";
import { judgeLimitsFor } from "@fragua/core/handler";
import { SqliteStore } from "@fragua/store";
import { AuthStorage, loadJudgeProviders, ModelRegistry } from "../src/index.ts";

function seed(store: SqliteStore, provider: string, config: unknown): void {
  store.upsertProviderConfig({ provider, config: JSON.stringify(config) });
}

describe("loadJudgeProviders", () => {
  test("the built-ins are there with no rows at all", () => {
    const store = new SqliteStore();
    try {
      const { providers, error } = loadJudgeProviders(store);
      expect(error).toBeNull();
      expect(providers["typesafe"]!.defaultModel).toBe("jev-1.13.0");
      // Ollaya's models do not cross providers, so it declares no default.
      expect(providers["ollaya"]!.defaultModel).toBeUndefined();
      expect(providers["ollaya"]!.auth).toBe("optional");
    } finally {
      store.close();
    }
  });

  test("a row overlays a built-in field by field", () => {
    const store = new SqliteStore();
    try {
      seed(store, "judge:ollaya", { "default-model": "winnow:e4b", "state-tokens": 3000 });
      const { providers, error } = loadJudgeProviders(store);
      expect(error).toBeNull();
      const o = providers["ollaya"]!;
      expect(o.defaultModel).toBe("winnow:e4b");
      expect(o.stateTokenBudget).toBe(3000);
      // Untouched fields keep the built-in's values.
      expect(o.baseUrl).toBe("http://127.0.0.1:11435");
      expect(o.usdPerInputToken).toBe(0);
    } finally {
      store.close();
    }
  });

  test("a row defines a new provider, and per-model limits survive", () => {
    const store = new SqliteStore();
    try {
      seed(store, "judge:lab", {
        "base-url": "http://10.0.0.5:8080",
        auth: "optional",
        "default-model": "kev",
        "request-tokens": 900,
        "state-tokens": 450,
        "bytes-per-token": 3.1,
        "state-max-bytes": 8192,
        models: { "laya:en": { "request-tokens": 400, "state-tokens": 200 } },
      });
      const { providers, error } = loadJudgeProviders(store);
      expect(error).toBeNull();
      const lab = providers["lab"]!;
      expect(lab.baseUrl).toBe("http://10.0.0.5:8080");
      expect(lab.bytesPerToken).toBe(3.1);
      expect(lab.models!["laya:en"]).toEqual({ requestTokenBudget: 400, stateTokenBudget: 200 });
    } finally {
      store.close();
    }
  });

  test("a new provider without a base URL is reported and skipped", () => {
    const store = new SqliteStore();
    try {
      seed(store, "judge:lab", { "default-model": "kev" });
      const { providers, error } = loadJudgeProviders(store);
      expect(providers["lab"]).toBeUndefined();
      expect(error).toMatch(/base-url/);
      // One bad row does not take the working providers down with it.
      expect(providers["typesafe"]).toBeDefined();
    } finally {
      store.close();
    }
  });

  test("a schema-invalid row is reported and skipped", () => {
    const store = new SqliteStore();
    try {
      seed(store, "judge:ollaya", { "base-url": "http://x", auth: "sometimes" });
      const { providers, error } = loadJudgeProviders(store);
      expect(error).toMatch(/invalid schema/);
      expect(providers["ollaya"]!.auth).toBe("optional");
    } finally {
      store.close();
    }
  });
});

describe("the `judge:` prefix keeps judge rows out of the llm registry", () => {
  test("ModelRegistry ignores a judge row instead of adopting it as a 0-model provider", () => {
    const store = new SqliteStore();
    try {
      seed(store, "judge:ollaya", { "base-url": "http://127.0.0.1:11435", "default-model": "kev" });
      const registry = ModelRegistry.create(AuthStorage.fromStore(store), store);
      expect(registry.getError()).toBeUndefined();
      expect(registry.getAll().some((m) => m.provider.startsWith("judge:"))).toBe(false);
      expect(registry.getAll().some((m) => m.provider === "ollaya")).toBe(false);
    } finally {
      store.close();
    }
  });

  test("an llm row for the same host still works beside the judge one", () => {
    const store = new SqliteStore();
    try {
      seed(store, "judge:ollaya", { "base-url": "http://127.0.0.1:11435", "default-model": "kev" });
      seed(store, "ollaya", {
        baseUrl: "http://127.0.0.1:11435/v1",
        api: "openai-completions",
        models: [
          {
            id: "some-chat",
            name: "some-chat",
            api: "openai-completions",
            contextWindow: 8_000,
            maxTokens: 1_024,
          },
        ],
      });
      const registry = ModelRegistry.create(AuthStorage.fromStore(store), store);
      expect(registry.find("ollaya", "some-chat")).toBeDefined();
      expect(loadJudgeProviders(store).providers["ollaya"]!.defaultModel).toBe("kev");
    } finally {
      store.close();
    }
  });
});

describe("per-model tokenizer ratios", () => {
  test("a model's bytes-per-token overrides the provider's, and a row can correct one number", () => {
    const store = new SqliteStore();
    try {
      // One field only: the model's other measured limits must survive.
      seed(store, "judge:ollaya", { models: { "laya:en": { "bytes-per-token": 5.2 } } });
      const o = loadJudgeProviders(store).providers["ollaya"]!;
      expect(o.models!["laya:en"]!.bytesPerToken).toBe(5.2);
      expect(o.models!["laya:en"]!.stateTokenBudget).toBe(440);
      // A sibling model keeps its own ratio.
      expect(o.models!["laya:multilingual"]!.bytesPerToken).toBe(4.4);
      // And a model with no entry falls back to the provider default.
      expect(judgeLimitsFor(o, "unlisted").bytesPerToken).toBe(o.bytesPerToken);
    } finally {
      store.close();
    }
  });
});
