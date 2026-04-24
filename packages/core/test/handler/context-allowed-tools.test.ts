// buildHandlerContext applies allowedTools / deniedTools as a hard filter on
// ctx.tools (ARCHITECTURE.md §5). A handler that reaches for a non-allowed
// tool gets `unknown tool: <name>`, same as for an unregistered one.

import { describe, expect, test } from "bun:test";
import { SqliteStore } from "@swarm/store";
import { buildHandlerContext } from "../../src/handler/context.ts";
import { InMemoryToolRegistry } from "../../src/handler/tool-registry.ts";
import type { SideEffectRecorder } from "../../src/handler/types.ts";

function recorder(): SideEffectRecorder {
  return {
    recordIntent: () => {},
    recordDone: () => {},
    recordFailed: () => {},
  };
}

describe("buildHandlerContext — allowedTools hard filter", () => {
  test("allowedTools narrows ctx.tools; disallowed get() throws", () => {
    const store = new SqliteStore({ path: ":memory:" });
    const tools = new InMemoryToolRegistry();
    tools.register({ name: "read", sideEffect: "none", handler: async () => undefined });
    tools.register({ name: "bash", sideEffect: "external", handler: async () => undefined });

    const ctx = buildHandlerContext({
      runId: "r",
      nodeId: "n",
      iteration: 0,
      signal: new AbortController().signal,
      routing: {},
      store,
      llm: { call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }) },
      http: { fetch: async () => new Response("") },
      tools,
      allowedTools: ["read"],
      recorder: recorder(),
    });

    expect(ctx.tools.list()).toEqual(["read"]);
    expect(ctx.tools.has("bash")).toBe(false);
    expect(() => ctx.tools.get("bash")).toThrow(/unknown tool: bash/);
    expect(ctx.tools.get("read").name).toBe("read");
    store.close();
  });

  test("no allowedTools / deniedTools → full registry visible", () => {
    const store = new SqliteStore({ path: ":memory:" });
    const tools = new InMemoryToolRegistry();
    tools.register({ name: "read", sideEffect: "none", handler: async () => undefined });
    tools.register({ name: "bash", sideEffect: "external", handler: async () => undefined });

    const ctx = buildHandlerContext({
      runId: "r",
      nodeId: "n",
      iteration: 0,
      signal: new AbortController().signal,
      routing: {},
      store,
      llm: { call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }) },
      http: { fetch: async () => new Response("") },
      tools,
      recorder: recorder(),
    });

    expect(ctx.tools.list()).toEqual(["bash", "read"]);
    store.close();
  });

  test("deniedTools subtracts from the full set", () => {
    const store = new SqliteStore({ path: ":memory:" });
    const tools = new InMemoryToolRegistry();
    tools.register({ name: "read", sideEffect: "none", handler: async () => undefined });
    tools.register({ name: "bash", sideEffect: "external", handler: async () => undefined });
    tools.register({ name: "write", sideEffect: "external", handler: async () => undefined });

    const ctx = buildHandlerContext({
      runId: "r",
      nodeId: "n",
      iteration: 0,
      signal: new AbortController().signal,
      routing: {},
      store,
      llm: { call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }) },
      http: { fetch: async () => new Response("") },
      tools,
      deniedTools: ["bash", "write"],
      recorder: recorder(),
    });

    expect(ctx.tools.list()).toEqual(["read"]);
    expect(() => ctx.tools.get("bash")).toThrow();
    store.close();
  });
});
