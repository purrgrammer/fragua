import { describe, expect, test } from "bun:test";
import { ok } from "@swarm/core";
import * as handler from "@swarm/core/handler";
import type { CodergenBackend, Node } from "@swarm/core";
import { SqliteStore } from "@swarm/store";
import { makeCodergenHandler } from "../src/handler-bridge.ts";

function node(overrides: Partial<Node> = {}): Node {
  return {
    id: overrides.id ?? "n1",
    attrs: {
      shape: "box",
      prompt: "What is 2+2?",
      ...(overrides.attrs ?? {}),
    },
  } as Node;
}

function stubBackend(
  emitScript: {
    totalTokens?: number;
    costUsd?: number;
    model?: string;
    assistantText?: string;
    toolText?: string;
  } = {},
): CodergenBackend {
  return {
    async run(input) {
      if (emitScript.totalTokens != null || emitScript.costUsd != null) {
        await input.emit?.("cost.recorded", {
          provider: "anthropic",
          model: emitScript.model ?? "claude-stub",
          stop_reason: "end_turn",
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: emitScript.totalTokens ?? 15,
          cost_usd: emitScript.costUsd ?? 0.001,
        });
      }
      if (emitScript.assistantText != null) {
        await input.emit?.("agent.message_end", {
          role: "assistant",
          message: { role: "assistant", content: emitScript.assistantText },
        });
      }
      if (emitScript.toolText != null) {
        await input.emit?.("agent.message_end", {
          role: "tool",
          message: {
            role: "tool",
            content: [{ type: "text", text: emitScript.toolText }],
          },
        });
      }
      return ok({ notes: "done", context_updates: { result: "four" } });
    },
  };
}

async function ctxFor(
  runId: string,
  store: SqliteStore,
  nodeId: string,
): Promise<handler.HandlerContext> {
  store.saveWorkflow("sha", "t", "digraph{}");
  store.enqueueRun({ runId, workflowSha: "sha" });
  const ac = new AbortController();
  const tools = new handler.InMemoryToolRegistry();
  return handler.buildHandlerContext({
    runId,
    nodeId,
    iteration: 0,
    signal: ac.signal,
    routing: { goal: "arithmetic" },
    store,
    llm: handler.makeLlmClient({
      signal: ac.signal,
      call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }),
    }),
    http: handler.makeHttpClient({ signal: ac.signal }),
    tools,
    recorder: {
      recordIntent: () => {},
      recordDone: () => {},
      recordFailed: () => {},
    },
  });
}

describe("makeCodergenHandler", () => {
  test("runs the backend and returns a transition with tokens/cost/model", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r1", store, "n1");
    const spec = makeCodergenHandler({
      node: node({ id: "n1" }),
      nextNode: "__end__",
      backend: stubBackend({
        totalTokens: 42,
        costUsd: 0.003,
        model: "claude-stub",
        assistantText: "Four.",
      }),
    });

    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.nextNode).toBe("__end__");
      expect(result.tokens).toBe(42);
      expect(result.costUsd).toBeCloseTo(0.003, 6);
      expect(result.modelName).toBe("claude-stub");
      expect(result.routingDelta).toMatchObject({ result: "four" });
    }
    store.close();
  });

  test("appends assistant + tool messages into ctx.messages", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r2", store, "n1");
    const spec = makeCodergenHandler({
      node: node({ id: "n1" }),
      nextNode: "__end__",
      backend: stubBackend({
        assistantText: "hello",
        toolText: "tool output",
      }),
    });

    await spec.handler(ctx);
    const msgs = store.getMessages("r2");
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ["assistant", "hello"],
      ["tool", "tool output"],
    ]);
    store.close();
  });

  test("backend fail → halt with failure_reason", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r3", store, "n1");
    const failing: CodergenBackend = {
      async run() {
        return { status: "fail", context_updates: {}, preferred_label: "", suggested_next_ids: [], notes: "", failure_reason: "provider unreachable" };
      },
    };
    const spec = makeCodergenHandler({
      node: node({ id: "n1" }),
      nextNode: "__end__",
      backend: failing,
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("halt");
    if (result.kind === "halt") {
      expect(result.detail).toBe("provider unreachable");
    }
    store.close();
  });

  test("next_node_override supersedes the configured nextNode", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r4", store, "n1");
    const overriding: CodergenBackend = {
      async run() {
        return ok({ next_node_override: "elsewhere" });
      },
    };
    const spec = makeCodergenHandler({
      node: node({ id: "n1" }),
      nextNode: "__end__",
      backend: overriding,
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") expect(result.nextNode).toBe("elsewhere");
    store.close();
  });
});
