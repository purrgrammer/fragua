// Per-model CLI ops (docs/proposals/provider-model-ops.md) \u2014 covers
// ls-models / add-model / rm-model / edit-model end-to-end against a
// real SqliteStore opened under a temp `$SWARM_HOME`. The wizard
// `prompts` UI is not under test; commands are driven with `--yes`
// (or the equivalent flag bag) to skip interactive confirmation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@swarm/store";
import {
  buildModelEntry,
  type ModelEntry,
  type ProviderEntry,
  providersAddModelCommand,
  providersEditModelCommand,
  providersLsModelsCommand,
  providersRmModelCommand,
} from "../src/commands/providers-custom.ts";

interface Captured {
  logs: string[];
  errors: string[];
  out: string;
  err: string;
}

let tmp: string;
let prevSwarmHome: string | undefined;
let captured: Captured;
let origLog: typeof console.log;
let origError: typeof console.error;

function seed(provider: string, entry: ProviderEntry): void {
  const store = new SqliteStore({ path: join(tmp, "swarm.db") });
  try {
    store.upsertProviderConfig({ provider, config: JSON.stringify(entry) });
  } finally {
    store.close();
  }
}

function read(provider: string): ProviderEntry | null {
  const store = new SqliteStore({ path: join(tmp, "swarm.db") });
  try {
    const row = store.getProviderConfig(provider);
    return row == null ? null : (row.config as ProviderEntry);
  } finally {
    store.close();
  }
}

function readUpdatedAt(provider: string): number | null {
  const store = new SqliteStore({ path: join(tmp, "swarm.db") });
  try {
    const row = store.getProviderConfig(provider);
    return row == null ? null : row.updatedAt;
  } finally {
    store.close();
  }
}

function makeEntry(modelIds: string[]): ProviderEntry {
  return {
    baseUrl: "http://localhost:11434/v1",
    api: "openai_completions",
    models: modelIds.map((id) => buildModelEntry({ id, api: "openai_completions" })),
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "swarm-providers-model-ops-"));
  prevSwarmHome = process.env["SWARM_HOME"];
  process.env["SWARM_HOME"] = tmp;
  captured = { logs: [], errors: [], out: "", err: "" };
  origLog = console.log;
  origError = console.error;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    captured.logs.push(line);
    captured.out += `${line}\n`;
  };
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    captured.errors.push(line);
    captured.err += `${line}\n`;
  };
});

afterEach(() => {
  console.log = origLog;
  console.error = origError;
  if (prevSwarmHome === undefined) delete process.env["SWARM_HOME"];
  else process.env["SWARM_HOME"] = prevSwarmHome;
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ls-models
// ---------------------------------------------------------------------------
describe("ls-models", () => {
  test("prints exactly N rows sorted by id when the provider has N models", async () => {
    seed("ollama", makeEntry(["mistral:7b", "llama3.1:8b", "qwen2.5:14b"]));
    const code = await providersLsModelsCommand("ollama");
    expect(code).toBe(0);
    // Find rows that lead with one of the seeded ids.
    const idLines = captured.logs.filter((l) => /^(llama|mistral|qwen)/.test(l));
    expect(idLines.length).toBe(3);
    const order = idLines.map((l) => l.split(/\s+/)[0]);
    expect(order).toEqual(["llama3.1:8b", "mistral:7b", "qwen2.5:14b"]);
  });

  test('exits 1 with the canonical "provider not found" message when no row matches', async () => {
    const code = await providersLsModelsCommand("ghost");
    expect(code).toBe(1);
    expect(captured.err).toContain('provider "ghost" not found in provider_config');
  });
});

// ---------------------------------------------------------------------------
// add-model
// ---------------------------------------------------------------------------
describe("add-model", () => {
  test("appends a new model row, advances updated_at, and survives a re-read", async () => {
    seed("ollama", makeEntry(["llama3.1:8b"]));
    const before = readUpdatedAt("ollama")!;
    // Force the next write to land at a strictly-later epoch ms.
    await new Promise((r) => setTimeout(r, 5));
    const code = await providersAddModelCommand("ollama", "qwen2.5:14b", {
      contextWindow: 999,
      maxTokens: 111,
      yes: true,
    });
    expect(code).toBe(0);
    const entry = read("ollama")!;
    expect(entry.models).toHaveLength(2);
    const fresh = entry.models.find((m) => m.id === "qwen2.5:14b")!;
    expect(fresh.contextWindow).toBe(999);
    expect(fresh.maxTokens).toBe(111);
    const after = readUpdatedAt("ollama")!;
    expect(after).toBeGreaterThan(before);
  });

  test("rejects duplicate model id and tells the caller to use edit-model", async () => {
    seed("ollama", makeEntry(["gpt-x"]));
    const code = await providersAddModelCommand("ollama", "gpt-x", { yes: true });
    expect(code).toBe(1);
    expect(captured.err).toContain("already exists");
    expect(captured.err).toContain("edit-model");
  });

  test("flag-supplied fields win over inferModelDefaults heuristics", async () => {
    seed("ppq", makeEntry(["base-model"]));
    const code = await providersAddModelCommand("ppq", "qwen-foo", {
      contextWindow: 4096,
      yes: true,
    });
    expect(code).toBe(0);
    const entry = read("ppq")!;
    const added = entry.models.find((m) => m.id === "qwen-foo")!;
    // qwen heuristic would have been 32_768 \u2014 the flag wins.
    expect(added.contextWindow).toBe(4096);
    // unflagged \u2192 falls back to the qwen heuristic 8_192.
    expect(added.maxTokens).toBe(8_192);
  });

  test('defaults reasoning=false, input=["text"], cost zeros when flags absent', async () => {
    seed("ollama", makeEntry(["seed"]));
    const code = await providersAddModelCommand("ollama", "fresh-model", { yes: true });
    expect(code).toBe(0);
    const entry = read("ollama")!;
    const fresh = entry.models.find((m) => m.id === "fresh-model")!;
    expect(fresh.reasoning).toBe(false);
    expect(fresh.input).toEqual(["text"]);
    expect(fresh.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test("Ajv-rejects a blob that fails the per-provider schema", async () => {
    // Seed a structurally-invalid row directly: `models` not an array.
    const store = new SqliteStore({ path: join(tmp, "swarm.db") });
    try {
      store.upsertProviderConfig({
        provider: "broken",
        config: JSON.stringify({ baseUrl: "http://x", models: "not-an-array" }),
      });
    } finally {
      store.close();
    }
    const code = await providersAddModelCommand("broken", "new-model", { yes: true });
    expect(code).toBe(1);
    expect(captured.err).toContain("schema validation failed");
  });
});

// ---------------------------------------------------------------------------
// rm-model
// ---------------------------------------------------------------------------
describe("rm-model", () => {
  test("removes one model and preserves the rest byte-identical", async () => {
    const entry = makeEntry(["a-one", "b-two", "c-three"]);
    // Customise b-two so we can detect any accidental mutation on the survivors.
    entry.models[0]!.cost.input = 1.5;
    entry.models[2]!.contextWindow = 65_536;
    seed("provx", entry);

    const survivorsBefore: ModelEntry[] = [entry.models[0]!, entry.models[2]!];
    const survivorSnapshot = JSON.stringify(
      survivorsBefore.map((m) => ({ ...m })).sort((a, b) => a.id.localeCompare(b.id)),
    );

    const code = await providersRmModelCommand("provx", "b-two", { yes: true });
    expect(code).toBe(0);
    const after = read("provx")!;
    expect(after.models).toHaveLength(2);
    const sorted = [...after.models].sort((a, b) => a.id.localeCompare(b.id));
    expect(JSON.stringify(sorted)).toBe(survivorSnapshot);
  });

  test("rejects missing model id and tells the caller to run ls-models", async () => {
    seed("ollama", makeEntry(["a"]));
    const code = await providersRmModelCommand("ollama", "ghost-model", { yes: true });
    expect(code).toBe(1);
    expect(captured.err).toContain("ghost-model");
    expect(captured.err).toContain("ls-models");
  });
});

// ---------------------------------------------------------------------------
// edit-model
// ---------------------------------------------------------------------------
describe("edit-model", () => {
  test("mutates only flag-supplied fields; everything else preserves byte-identical", async () => {
    const entry = makeEntry(["target"]);
    // Populate every field on the target so we can verify byte-identical preservation.
    const t = entry.models[0]!;
    t.name = "Original Name";
    t.contextWindow = 12345;
    t.maxTokens = 6789;
    t.reasoning = true;
    t.input = ["text", "image"];
    t.cost = { input: 1.1, output: 2.2, cacheRead: 3.3, cacheWrite: 4.4 };
    seed("prov", entry);

    const code = await providersEditModelCommand("prov", "target", { costOutput: 7, yes: true });
    expect(code).toBe(0);
    const after = read("prov")!;
    const updated = after.models.find((m) => m.id === "target")!;
    expect(updated.cost.output).toBe(7);
    // Every other field byte-identical.
    expect(updated.name).toBe("Original Name");
    expect(updated.contextWindow).toBe(12345);
    expect(updated.maxTokens).toBe(6789);
    expect(updated.reasoning).toBe(true);
    expect(updated.input).toEqual(["text", "image"]);
    expect(updated.cost.input).toBe(1.1);
    expect(updated.cost.cacheRead).toBe(3.3);
    expect(updated.cost.cacheWrite).toBe(4.4);
  });

  test("rejects missing model id and tells the caller to use add-model", async () => {
    seed("ollama", makeEntry(["a"]));
    const code = await providersEditModelCommand("ollama", "no-such", { name: "x", yes: true });
    expect(code).toBe(1);
    expect(captured.err).toContain("no-such");
    expect(captured.err).toContain("add-model");
  });
});

// ---------------------------------------------------------------------------
// provider lookup \u2014 the canonical "not found" message on every verb
// ---------------------------------------------------------------------------
describe("provider lookup", () => {
  test("all four verbs exit 1 with the canonical message when <provider> doesn't exist", async () => {
    const ls = await providersLsModelsCommand("nope");
    expect(ls).toBe(1);
    expect(captured.err).toContain("not found in provider_config");
    captured.err = "";

    const add = await providersAddModelCommand("nope", "m", { yes: true });
    expect(add).toBe(1);
    expect(captured.err).toContain("not found in provider_config");
    captured.err = "";

    const rm = await providersRmModelCommand("nope", "m", { yes: true });
    expect(rm).toBe(1);
    expect(captured.err).toContain("not found in provider_config");
    captured.err = "";

    const edit = await providersEditModelCommand("nope", "m", { name: "x", yes: true });
    expect(edit).toBe(1);
    expect(captured.err).toContain("not found in provider_config");
  });
});
