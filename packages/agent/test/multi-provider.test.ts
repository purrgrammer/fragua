// Verify provider/model resolution flows through the backend without
// requiring real API credentials. Uses a stub resolveModel that records
// the arguments it's called with.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import { registerFauxProvider } from "@mariozechner/pi-ai";
import { execute, InMemorySink, parseDotSource } from "@swarm/core";
import { LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import {
  fauxAssistantMessage,
  firstCredentialedProvider,
  hasProviderCredentials,
  KNOWN_PROVIDERS,
  PiCodergenBackend,
} from "../src/index.ts";

describe("multi-provider resolution", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-multi-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("node-level provider + model override reach the resolver", async () => {
    const registration = registerFauxProvider();
    registration.setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
    try {
      const seen: Array<[string, string]> = [];
      const backend = new PiCodergenBackend({
        registry: new ToolRegistry(),
        env: new LocalEnvironment({ cwd: scratch }),
        resolveModel: (provider, modelId) => {
          seen.push([provider, modelId]);
          return registration.getModel() as Model<string>;
        },
        defaultModel: { provider: "anthropic", model: "claude-haiku-4-5" },
      });

      const graph = parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          t [provider="openrouter", model="anthropic/claude-sonnet-4.5", prompt="hi"]
          done [shape=Msquare]
          s -> t -> done
        }
      `);
      await execute({ graph, backend, sink: new InMemorySink() });
      expect(seen).toEqual([["openrouter", "anthropic/claude-sonnet-4.5"]]);
    } finally {
      registration.unregister();
    }
  });

  test("default provider used when node omits attrs", async () => {
    const registration = registerFauxProvider();
    registration.setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
    try {
      const seen: Array<[string, string]> = [];
      const backend = new PiCodergenBackend({
        registry: new ToolRegistry(),
        env: new LocalEnvironment({ cwd: scratch }),
        resolveModel: (provider, modelId) => {
          seen.push([provider, modelId]);
          return registration.getModel() as Model<string>;
        },
        defaultModel: { provider: "openrouter", model: "google/gemini-2.5-pro" },
      });
      const graph = parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          t [prompt="hi"]
          done [shape=Msquare]
          s -> t -> done
        }
      `);
      await execute({ graph, backend, sink: new InMemorySink() });
      expect(seen).toEqual([["openrouter", "google/gemini-2.5-pro"]]);
    } finally {
      registration.unregister();
    }
  });
});

describe("provider catalog", () => {
  test("openrouter is listed with OPENROUTER_API_KEY env var", () => {
    const openrouter = KNOWN_PROVIDERS.find((p) => p.name === "openrouter");
    expect(openrouter).toBeDefined();
    expect(openrouter!.envVars).toContain("OPENROUTER_API_KEY");
  });

  test("hasProviderCredentials reflects the current env", () => {
    const original = process.env["OPENROUTER_API_KEY"];
    try {
      process.env["OPENROUTER_API_KEY"] = "";
      delete process.env["OPENROUTER_API_KEY"];
      expect(hasProviderCredentials("openrouter")).toBe(false);
      process.env["OPENROUTER_API_KEY"] = "sk-or-test-fake";
      expect(hasProviderCredentials("openrouter")).toBe(true);
    } finally {
      if (original === undefined) delete process.env["OPENROUTER_API_KEY"];
      else process.env["OPENROUTER_API_KEY"] = original;
    }
  });

  test("firstCredentialedProvider picks something only when env has a key", () => {
    const saved: Record<string, string | undefined> = {};
    for (const p of KNOWN_PROVIDERS) {
      for (const v of p.envVars) {
        saved[v] = process.env[v];
        delete process.env[v];
      }
    }
    try {
      expect(firstCredentialedProvider()).toBeUndefined();
      process.env["OPENROUTER_API_KEY"] = "sk-or-test-fake";
      expect(firstCredentialedProvider()?.name).toBe("openrouter");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
