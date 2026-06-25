// fragua run: full round-trip — the CLI saves the workflow + enqueues directly
// on the store, then tails the event log to terminal. A foreground executor
// fiber over the same file-backed store makes the run actually progress.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as handler from "@fragua/core/handler";
import { AbortRegistry, autoDispatcherResolver, Dispatcher, runExecutor } from "@fragua/daemon";
import { SqliteStore } from "@fragua/store";
import { runCommand } from "../src/commands/run.ts";
import { coerceInputs, resolveInputArgs } from "../src/input-coerce.ts";

interface Rig {
  dbPath: string;
  store: SqliteStore;
  close: () => Promise<void>;
}

const tmps: string[] = [];

afterEach(() => {
  while (tmps.length > 0) {
    const d = tmps.pop();
    try {
      if (d != null) rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

/** A file-backed store + a foreground executor fiber over it, so a followed
 * run progresses to terminal. No server — the CLI is a store-client. */
function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "fragua-run-"));
  tmps.push(dir);
  mkdirSync(join(dir, ".fragua"), { recursive: true });
  const dbPath = join(dir, ".fragua/fragua.db");
  const store = new SqliteStore({ path: dbPath });

  const dispatcher = new Dispatcher();
  dispatcher.setResolver(autoDispatcherResolver({ store }));
  const tools = new handler.InMemoryToolRegistry();
  const llmCall: handler.LlmCallFn = async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" });

  const shutdown = new AbortController();
  const executorPromise = runExecutor({
    store,
    dispatcher,
    registry: new AbortRegistry(),
    tools,
    llmCall,
    maxConcurrentRuns: 2,
    pollIntervalMs: 10,
    shutdownSignal: shutdown.signal,
  }).catch(() => {});

  return {
    dbPath,
    store,
    close: async () => {
      shutdown.abort();
      await executorPromise;
      store.close();
    },
  };
}

function writeWorkflow(): string {
  const workflowDir = mkdtempSync(join(tmpdir(), "fragua-wf-"));
  tmps.push(workflowDir);
  const yamlPath = join(workflowDir, "echo.yaml");
  writeFileSync(yamlPath, `name: echo\nsteps:\n  work: {type: llm, prompt: hi, next: exit}\n`);
  return yamlPath;
}

describe("fragua run", () => {
  test("round-trip: YAML file → save → enqueue → tail → completed", async () => {
    const r = rig();
    try {
      const exitCode = await runCommand({ workflow: writeWorkflow(), dbPath: r.dbPath });
      expect(exitCode).toBe(0);
    } finally {
      await r.close();
    }
  });

  test("cannot read workflow file → exit 1 (before opening the store)", async () => {
    const code = await runCommand({ workflow: "/nonexistent/workflow.yaml", dbPath: "/nonexistent/x.db" });
    expect(code).toBe(1);
  });

  test("missing store → exit 1 with actionable guidance", async () => {
    const errs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errs.push(args.map(String).join(" "));
    };
    try {
      const code = await runCommand({ workflow: writeWorkflow(), dbPath: join(tmpdir(), "fragua-absent-xyz/none.db") });
      expect(code).toBe(1);
    } finally {
      console.error = originalError;
    }
    const joined = errs.join("\n");
    expect(joined).toContain("no fragua store");
    expect(joined).toContain("harness");
  });

  test("--no-follow exits immediately after enqueue", async () => {
    const r = rig();
    try {
      const code = await runCommand({ workflow: writeWorkflow(), dbPath: r.dbPath, follow: false });
      expect(code).toBe(0);
    } finally {
      await r.close();
    }
  });

  test("--input-json end-to-end: enqueued routing.inputs carries the parsed shape", async () => {
    const r = rig();
    try {
      const dir = mkdtempSync(join(tmpdir(), "fragua-wf-"));
      tmps.push(dir);
      const yamlPath = join(dir, "typed.yaml");
      writeFileSync(
        yamlPath,
        "name: typed\ninputs:\n  ticket: {type: string}\nsteps:\n  work: {type: llm, prompt: hi, next: exit}\n",
      );
      const code = await runCommand({
        workflow: yamlPath,
        dbPath: r.dbPath,
        follow: false,
        inputJson: '{"ticket":"BUG-1"}',
      });
      expect(code).toBe(0);
      const runId = r.store.listRunIds()[0]!;
      expect(r.store.getState(runId)!.routing["inputs"]).toEqual({ ticket: "BUG-1" });
    } finally {
      await r.close();
    }
  });

  test("--input end-to-end: number/boolean inputs are coerced into routing.inputs", async () => {
    const r = rig();
    try {
      const dir = mkdtempSync(join(tmpdir(), "fragua-wf-"));
      tmps.push(dir);
      const yamlPath = join(dir, "nb.yaml");
      writeFileSync(
        yamlPath,
        "name: nb\ninputs:\n  count: {type: number}\n  flag: {type: boolean}\nsteps:\n  work: {type: llm, prompt: hi, next: exit}\n",
      );
      const code = await runCommand({
        workflow: yamlPath,
        dbPath: r.dbPath,
        follow: false,
        inputs: { count: "3", flag: "true" },
      });
      expect(code).toBe(0);
      const runId = r.store.listRunIds()[0]!;
      expect(r.store.getState(runId)!.routing["inputs"]).toEqual({ count: 3, flag: true });
    } finally {
      await r.close();
    }
  });

  test("--input config=@file.json end-to-end: parsed object lands on routing.inputs", async () => {
    const r = rig();
    try {
      const dir = mkdtempSync(join(tmpdir(), "fragua-wf-"));
      tmps.push(dir);
      const yamlPath = join(dir, "obj.yaml");
      writeFileSync(
        yamlPath,
        "name: obj\ninputs:\n  config:\n    type: object\n    fields:\n      env: {type: string}\nsteps:\n  work: {type: llm, prompt: hi, next: exit}\n",
      );
      const jsonPath = join(dir, "config.json");
      writeFileSync(jsonPath, '{"env":"prod"}');
      const inputs = (await resolveInputArgs([`config=@${jsonPath}`])) as Record<string, string>;
      const code = await runCommand({ workflow: yamlPath, dbPath: r.dbPath, follow: false, inputs });
      expect(code).toBe(0);
      const runId = r.store.listRunIds()[0]!;
      expect(r.store.getState(runId)!.routing["inputs"]).toEqual({ config: { env: "prod" } });
    } finally {
      await r.close();
    }
  });

  test("--input config=@file.json with malformed JSON fails with invalid_shape", async () => {
    const r = rig();
    const errs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errs.push(args.map(String).join(" "));
    };
    try {
      const dir = mkdtempSync(join(tmpdir(), "fragua-wf-"));
      tmps.push(dir);
      const yamlPath = join(dir, "obj.yaml");
      writeFileSync(
        yamlPath,
        "name: obj\ninputs:\n  config:\n    type: object\n    fields:\n      env: {type: string}\nsteps:\n  work: {type: llm, prompt: hi, next: exit}\n",
      );
      const jsonPath = join(dir, "config.json");
      writeFileSync(jsonPath, "{not json");
      const inputs = (await resolveInputArgs([`config=@${jsonPath}`])) as Record<string, string>;
      const code = await runCommand({ workflow: yamlPath, dbPath: r.dbPath, follow: false, inputs });
      expect(code).toBe(1);
      expect(r.store.listRunIds()).toHaveLength(0);
    } finally {
      console.error = originalError;
      await r.close();
    }
    expect(errs.join("\n")).toContain("is not valid JSON");
  });

  test("--title is recorded on the run; no free-form input is set", async () => {
    const r = rig();
    try {
      const code = await runCommand({
        workflow: writeWorkflow(),
        dbPath: r.dbPath,
        follow: false,
        title: "Rename foo to bar",
      });
      expect(code).toBe(0);
      const runId = r.store.listRunIds()[0]!;
      const state = r.store.getState(runId)!;
      expect(state.title).toBe("Rename foo to bar");
      expect(state.routing["input"]).toBeUndefined();
    } finally {
      await r.close();
    }
  });
});

describe("resolveInputArgs", () => {
  test("parses repeated name=value pairs; value may contain '='", async () => {
    const out = await resolveInputArgs(["env=prod", "url=a=b"]);
    expect(out).toEqual({ env: "prod", url: "a=b" });
  });

  test("a single flag arrives as a string, not an array", async () => {
    expect(await resolveInputArgs("ticket=BUG-1")).toEqual({ ticket: "BUG-1" });
  });

  test("undefined → empty map", async () => {
    expect(await resolveInputArgs(undefined)).toEqual({});
  });

  test("@path sources the value verbatim from a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fragua-input-"));
    tmps.push(dir);
    const specPath = join(dir, "spec.md");
    writeFileSync(specPath, "add a touch tool\nwith two lines\n");
    const out = await resolveInputArgs([`task=@${specPath}`]);
    expect(out["task"]).toBe("add a touch tool\nwith two lines\n");
  });

  test("malformed entry (no '=' / empty name) throws", async () => {
    await expect(resolveInputArgs(["nokey"])).rejects.toThrow(/name=value/);
    await expect(resolveInputArgs(["=value"])).rejects.toThrow(/name=value/);
  });
});

describe("coerceInputs (merge-only; type coercion lives in buildEnqueue)", () => {
  test("per-input strings pass through verbatim — no per-type coercion here", () => {
    expect(coerceInputs({ tags: '["a","b"]', count: "3", flag: "true", ticket: "BUG-1" }, undefined)).toEqual({
      tags: '["a","b"]',
      count: "3",
      flag: "true",
      ticket: "BUG-1",
    });
  });

  test("--input-json supplies the whole inputs object; per-input flags override (as strings)", () => {
    const out = coerceInputs({ tags: '["x"]' }, '{"ticket":"BUG-1","tags":["old"]}');
    expect(out).toEqual({ ticket: "BUG-1", tags: '["x"]' });
  });

  test("--input-json values pass through pre-parsed when not overridden", () => {
    expect(coerceInputs({}, '{"count":3,"flag":true,"cfg":{"env":"prod"}}')).toEqual({
      count: 3,
      flag: true,
      cfg: { env: "prod" },
    });
  });

  test("malformed --input-json throws a clear error", () => {
    expect(() => coerceInputs({}, "{not json")).toThrow(/--input-json is not valid JSON/);
  });

  test("--input-json must be a JSON object, not an array/scalar", () => {
    expect(() => coerceInputs({}, "[1,2]")).toThrow(/must be a JSON object/);
  });

  test("--input-json with a __proto__ key does not pollute the result or Object.prototype", () => {
    const out = coerceInputs({}, '{"__proto__":{"polluted":"yes"},"ticket":"BUG-1"}');
    expect(out).toEqual({ ticket: "BUG-1" });
    expect((out as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("--input-json keeps own constructor / prototype keys (symmetric with k=v)", () => {
    const out = coerceInputs({}, '{"constructor":"a","prototype":"b"}');
    expect(Object.hasOwn(out, "constructor")).toBe(true);
    expect(Object.hasOwn(out, "prototype")).toBe(true);
    expect(out["constructor"]).toBe("a");
  });
});
