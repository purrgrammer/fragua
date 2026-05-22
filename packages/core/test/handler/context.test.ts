import { describe, expect, test } from "bun:test";
import { SqliteStore } from "@fragua/store";
import { buildHandlerContext } from "../../src/handler/context.ts";
import { makeHttpClient } from "../../src/handler/http-client.ts";
import { makeLlmClient } from "../../src/handler/llm-client.ts";
import { InMemoryToolRegistry } from "../../src/handler/tool-registry.ts";
import type { SideEffectRecorder } from "../../src/handler/types.ts";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "../../src/index.ts";

function seedStore() {
  const store = new SqliteStore({ path: ":memory:" });
  store.saveWorkflow(
    "sha",
    "t",
    "name: t\nsteps:\n  work: {type: llm, prompt: x}\n",
    serializeGraph(parseWorkflow("name: t\nsteps:\n  work: {type: llm, prompt: x}\n")),
    CURRENT_IR_VERSION,
  );
  store.enqueueRun({ runId: "r1", workflowSha: "sha" });
  return store;
}

function stubRecorder(): SideEffectRecorder {
  return {
    recordIntent: () => {},
    recordDone: () => {},
    recordFailed: () => {},
  };
}

describe("buildHandlerContext", () => {
  test("messages.append round-trips through the store", async () => {
    const store = seedStore();
    const ac = new AbortController();
    const ctx = buildHandlerContext({
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      signal: ac.signal,
      routing: {},
      store,
      llm: makeLlmClient({
        signal: ac.signal,
        call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }),
      }),
      http: makeHttpClient({ signal: ac.signal }),
      tools: new InMemoryToolRegistry(),
      recorder: stubRecorder(),
    });

    ctx.messages.append({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
    ctx.messages.append({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      api: "anthropic" as never,
      provider: "anthropic" as never,
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    const recent = ctx.messages.recent(10);
    expect(recent.map((m) => m.content.role)).toEqual(["user", "assistant"]);
    store.close();
  });

  test("artifacts.put writes blob + ref that get/ref can read back", async () => {
    const store = seedStore();
    const ac = new AbortController();
    const ctx = buildHandlerContext({
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      signal: ac.signal,
      routing: {},
      store,
      llm: makeLlmClient({
        signal: ac.signal,
        call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }),
      }),
      http: makeHttpClient({ signal: ac.signal }),
      tools: new InMemoryToolRegistry(),
      recorder: stubRecorder(),
    });

    const ref = ctx.artifacts.put("out", "payload", "text/plain");
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new TextDecoder().decode(ctx.artifacts.get("out"))).toBe("payload");
    expect(ctx.artifacts.ref("missing")).toBeNull();
    store.close();
  });
});

describe("llmClient", () => {
  test("reports usage into accounting and refuses on pre-aborted signal", async () => {
    const usage: Array<{ tokens: number; costUsd: number; model: string }> = [];
    const ac = new AbortController();
    const llm = makeLlmClient({
      signal: ac.signal,
      call: async () => ({
        content: "hi",
        tokens: 7,
        costUsd: 0.001,
        model: "stub",
      }),
      accounting: { addUsage: (p) => usage.push(p) },
    });
    await llm.call({ model: "stub", messages: [] });
    expect(usage).toEqual([{ tokens: 7, costUsd: 0.001, model: "stub" }]);

    ac.abort();
    await expect(llm.call({ model: "stub", messages: [] })).rejects.toBeDefined();
  });
});

describe("httpClient", () => {
  test("composes caller signal with context signal", async () => {
    const ac = new AbortController();
    let seenAborted = false;
    const http = makeHttpClient({
      signal: ac.signal,
      fetch: (async (_input: unknown, init?: { signal?: AbortSignal }) => {
        seenAborted = init?.signal?.aborted === true;
        return new Response("ok");
      }) as unknown as typeof fetch,
    });
    ac.abort();
    await http.fetch("https://example.test");
    expect(seenAborted).toBe(true);
  });
});

describe("InMemoryToolRegistry", () => {
  test("register / get / has / list", () => {
    const r = new InMemoryToolRegistry();
    r.register({
      name: "echo",
      sideEffect: "none",
      handler: async (a: string) => a,
    });
    expect(r.has("echo")).toBe(true);
    expect(r.list()).toEqual(["echo"]);
    expect(r.get("echo").name).toBe("echo");
    expect(() => r.get("missing")).toThrow(/unknown tool/);
    expect(() => r.register({ name: "echo", sideEffect: "none", handler: async () => 0 })).toThrow(
      /already registered/,
    );
  });
});
