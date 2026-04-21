import { describe, expect, test } from "bun:test";
import type { CodergenBackend, Node, OutcomeStatus } from "@swarm/core";
import { ok } from "@swarm/core";
import * as handler from "@swarm/core/handler";
import { SqliteStore } from "@swarm/store";
import fc from "fast-check";
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
        input.persistMessage?.({
          role: "assistant",
          content: [{ type: "text", text: emitScript.assistantText }],
          api: "anthropic" as never,
          provider: "anthropic" as never,
          model: emitScript.model ?? "claude-stub",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        });
      }
      if (emitScript.toolText != null) {
        input.persistMessage?.({
          role: "toolResult",
          toolCallId: "stub",
          toolName: "stub",
          content: [{ type: "text", text: emitScript.toolText }],
          isError: false,
          timestamp: 2,
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
  args: Readonly<Record<string, string>> = {},
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
    args,
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
    expect(msgs.map((m) => m.content.role)).toEqual(["assistant", "toolResult"]);
    const first = msgs[0]?.content;
    const second = msgs[1]?.content;
    expect(first?.role === "assistant" && Array.isArray(first.content) && first.content[0]).toMatchObject({
      type: "text",
      text: "hello",
    });
    expect(second?.role === "toolResult" && second.content[0]).toMatchObject({ type: "text", text: "tool output" });
    store.close();
  });

  test("backend fail → halt with failure_reason", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r3", store, "n1");
    const failing: CodergenBackend = {
      async run() {
        return {
          status: "fail",
          context_updates: {},
          preferred_label: "",
          suggested_next_ids: [],
          notes: "",
          failure_reason: "provider unreachable",
        };
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

  test("substitutes ctx.args into node.attrs.prompt before backend.run()", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r-sub", store, "n1", {
      $ARGUMENTS: "rename foo() to bar()",
      $RUN_ID: "r-sub",
    });
    let seenPrompt: string | undefined;
    const capture: CodergenBackend = {
      async run(input) {
        seenPrompt = input.prompt;
        return ok({});
      },
    };
    const spec = makeCodergenHandler({
      node: node({ attrs: { shape: "box", prompt: "Task: $ARGUMENTS (run=$RUN_ID)" } }),
      nextNode: "__end__",
      backend: capture,
    });
    await spec.handler(ctx);
    expect(seenPrompt).toBe("Task: rename foo() to bar() (run=r-sub)");
    store.close();
  });

  test("empty args collapse $ARGUMENTS to '' rather than leaking the literal", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r-empty", store, "n1");
    let seenPrompt: string | undefined;
    const capture: CodergenBackend = {
      async run(input) {
        seenPrompt = input.prompt;
        return ok({});
      },
    };
    const spec = makeCodergenHandler({
      node: node({ attrs: { shape: "box", prompt: "[$ARGUMENTS]" } }),
      nextNode: "__end__",
      backend: capture,
    });
    await spec.handler(ctx);
    expect(seenPrompt).toBe("[]");
    expect(seenPrompt?.includes("$ARGUMENTS")).toBe(false);
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

// Regression / property suite for "codergen routing belongs to the edge
// selector, not the handler". Before this was locked in, the daemon's
// codergenFactory forwarded `first = outbound[0]` to makeCodergenHandler,
// which meant every codergen call forced its nextNode to whichever edge
// happened to appear first in the DOT — bypassing the selector and
// sending e.g. `outcome=success` runs down an `outcome=fail` branch
// just because that branch was declared first.
//
// The invariants these tests lock:
//   (I1) No `nextNode` option + no `next_node_override`
//        → HandlerResult.nextNode is undefined (selector decides).
//   (I2) Setting `nextNode` option alone still works for the legacy
//        transition-spec path (tool/transition nodes with a single
//        outgoing edge).
//   (I3) `next_node_override` always wins — even when both `nextNode`
//        option is set AND outcomeStatus is non-success.
describe("makeCodergenHandler — routing delegation invariants", () => {
  test("(I1) no nextNode option + no override → result.nextNode undefined", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r-inv-1", store, "n1");
    const backend: CodergenBackend = {
      async run() {
        return ok({});
      },
    };
    const spec = makeCodergenHandler({ node: node({ id: "n1" }), backend });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") expect(result.nextNode).toBeUndefined();
    store.close();
  });

  test("(I2) nextNode option alone propagates when no override is set", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r-inv-2", store, "n1");
    const backend: CodergenBackend = {
      async run() {
        return ok({});
      },
    };
    const spec = makeCodergenHandler({ node: node({ id: "n1" }), nextNode: "legacy-target", backend });
    const result = await spec.handler(ctx);
    if (result.kind === "transition") expect(result.nextNode).toBe("legacy-target");
    store.close();
  });

  test("(I3) next_node_override wins over the nextNode option", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r-inv-3", store, "n1");
    const backend: CodergenBackend = {
      async run() {
        return ok({ next_node_override: "override-target" });
      },
    };
    const spec = makeCodergenHandler({ node: node({ id: "n1" }), nextNode: "legacy-target", backend });
    const result = await spec.handler(ctx);
    if (result.kind === "transition") expect(result.nextNode).toBe("override-target");
    store.close();
  });

  test("property: (I1) holds across arbitrary outcomeStatus + context_updates", async () => {
    const statuses: OutcomeStatus[] = ["success", "partial_success", "skipped"];
    // `fail` and `retry` route through a different handler-bridge branch
    // (kind=halt), so they're excluded from this invariant — the "no
    // nextNode forcing" property targets transition-kind results only.
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...statuses),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.oneof(fc.string(), fc.integer(), fc.boolean())),
        async (status, updates) => {
          const store = new SqliteStore({ path: ":memory:" });
          try {
            const ctx = await ctxFor(`r-prop-${Math.random()}`, store, "n1");
            const backend: CodergenBackend = {
              async run() {
                return {
                  status,
                  context_updates: updates as Record<string, string | number | boolean>,
                  preferred_label: "",
                  suggested_next_ids: [],
                  notes: "",
                };
              },
            };
            const spec = makeCodergenHandler({ node: node({ id: "n1" }), backend });
            const result = await spec.handler(ctx);
            // Invariant: no forced nextNode when the caller didn't supply
            // one and the outcome didn't override. The executor's edge
            // selector must be free to pick based on outcomeStatus +
            // condition matching.
            if (result.kind === "transition") {
              expect(result.nextNode).toBeUndefined();
              expect(result.outcomeStatus).toBe(status);
            }
          } finally {
            store.close();
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
