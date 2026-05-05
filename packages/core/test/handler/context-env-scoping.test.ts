// buildHandlerContext aligns ctx.env with ctx.tools. A node whose
// narrowed toolset has no mutator (bash / write / edit) receives a
// read-only env, so a handler can't skirt the filter by writing through
// env directly.

import { describe, expect, test } from "bun:test";
import { SqliteStore } from "@swarm/store";
import { buildHandlerContext } from "../../src/handler/context.ts";
import { InMemoryToolRegistry } from "../../src/handler/tool-registry.ts";
import type { SideEffectRecorder } from "../../src/handler/types.ts";
import type { ExecutionEnvironment } from "../../src/types/execution.ts";
import { ReadOnlyEnvError } from "../../src/types/read-only-env.ts";

function fullEnv(): ExecutionEnvironment {
  return {
    cwd: () => "/work",
    projectCwd: () => "/work",
    readFile: async () => "ok",
    writeFile: async () => {},
    exists: async () => true,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
    listDir: async () => [],
    glob: async () => [],
  };
}

function recorder(): SideEffectRecorder {
  return {
    recordIntent: () => {},
    recordDone: () => {},
    recordFailed: () => {},
  };
}

function registry(): InMemoryToolRegistry {
  const r = new InMemoryToolRegistry();
  r.register({ name: "read", sideEffect: "none", handler: async () => undefined });
  r.register({ name: "write", sideEffect: "external", handler: async () => undefined });
  r.register({ name: "bash", sideEffect: "external", handler: async () => undefined });
  return r;
}

describe("buildHandlerContext — env scoping follows allowed_tools", () => {
  test('allowed_tools:["read"] → ctx.env rejects writeFile and exec', async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = buildHandlerContext({
      runId: "r",
      nodeId: "n",
      iteration: 0,
      signal: new AbortController().signal,
      routing: {},
      store,
      llm: { call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }) },
      http: { fetch: async () => new Response("") },
      tools: registry(),
      allowedTools: ["read"],
      env: fullEnv(),
      recorder: recorder(),
    });
    expect(ctx.env).toBeDefined();
    // Reads still work.
    expect(await ctx.env!.readFile("any")).toBe("ok");
    // Writes don't.
    expect(() => ctx.env!.writeFile("x", "y")).toThrow(ReadOnlyEnvError);
    expect(() => ctx.env!.exec("ls")).toThrow(ReadOnlyEnvError);
    store.close();
  });

  test('allowed_tools:["read","bash"] → ctx.env keeps full access', async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = buildHandlerContext({
      runId: "r",
      nodeId: "n",
      iteration: 0,
      signal: new AbortController().signal,
      routing: {},
      store,
      llm: { call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }) },
      http: { fetch: async () => new Response("") },
      tools: registry(),
      allowedTools: ["read", "bash"],
      env: fullEnv(),
      recorder: recorder(),
    });
    // Both work because bash is in the allowed set.
    expect(await ctx.env!.readFile("x")).toBe("ok");
    const res = await ctx.env!.exec("echo hi");
    expect(res.exitCode).toBe(0);
    store.close();
  });

  test('denied_tools:["bash","write","edit"] on a registry that has those → env is read-only', async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = buildHandlerContext({
      runId: "r",
      nodeId: "n",
      iteration: 0,
      signal: new AbortController().signal,
      routing: {},
      store,
      llm: { call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }) },
      http: { fetch: async () => new Response("") },
      tools: registry(),
      deniedTools: ["bash", "write", "edit"],
      env: fullEnv(),
      recorder: recorder(),
    });
    expect(() => ctx.env!.writeFile("x", "y")).toThrow(ReadOnlyEnvError);
    store.close();
  });

  test("empty registry + allowed_tools lists mutators → env stays writable", async () => {
    // Regression for the daemon path: swarm's executor receives an empty
    // sentinel registry while codergen uses its own. The env-wrap decision
    // must be based on the declared allowed_tools, not the runtime registry.
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = buildHandlerContext({
      runId: "r",
      nodeId: "n",
      iteration: 0,
      signal: new AbortController().signal,
      routing: {},
      store,
      llm: { call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }) },
      http: { fetch: async () => new Response("") },
      tools: new InMemoryToolRegistry(),
      allowedTools: ["read", "write", "edit", "bash"],
      env: fullEnv(),
      recorder: recorder(),
    });
    expect(await ctx.env!.readFile("x")).toBe("ok");
    const res = await ctx.env!.exec("echo hi");
    expect(res.exitCode).toBe(0);
    await ctx.env!.writeFile("x", "y");
    store.close();
  });

  test("no narrowing at all → env stays writable regardless of registry contents", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = buildHandlerContext({
      runId: "r",
      nodeId: "n",
      iteration: 0,
      signal: new AbortController().signal,
      routing: {},
      store,
      llm: { call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }) },
      http: { fetch: async () => new Response("") },
      tools: new InMemoryToolRegistry(),
      env: fullEnv(),
      recorder: recorder(),
    });
    const res = await ctx.env!.exec("echo hi");
    expect(res.exitCode).toBe(0);
    store.close();
  });

  test("no env supplied → ctx.env stays undefined", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = buildHandlerContext({
      runId: "r",
      nodeId: "n",
      iteration: 0,
      signal: new AbortController().signal,
      routing: {},
      store,
      llm: { call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }) },
      http: { fetch: async () => new Response("") },
      tools: registry(),
      allowedTools: ["read"],
      recorder: recorder(),
    });
    expect(ctx.env).toBeUndefined();
    store.close();
  });
});
