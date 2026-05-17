import { describe, expect, test } from "bun:test";
import type { CodergenBackend, Node, OutcomeStatus } from "@swarm/core";
import { failProvider, ok } from "@swarm/core";
import * as handler from "@swarm/core/handler";
import { MAX_MESSAGE_CONTENT_BYTES, SqliteStore } from "@swarm/store";
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

  test("backend fail → transition with outcomeStatus=fail and a typed failureReason", async () => {
    // Was: `fail` short-circuited to halt, blocking workflows with a
    // `condition="outcome=fail"` recovery edge (build-feature: review→fix).
    // Now: bridge returns transition; executor's edge selector routes the
    // fail outcome (or halts if no fail-edge exists). The agent's
    // `failure_reason` rides on the transition's typed `failureReason`
    // field, which result-to-facts surfaces as `fact.run_halted.detail`.
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r3", store, "n1");
    const failing: CodergenBackend = {
      async run() {
        return {
          status: "fail",
          context_updates: { thing: "value" },
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
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.outcomeStatus).toBe("fail");
      expect(result.failureReason).toBe("provider unreachable");
      // context_updates still flow through routingDelta; failureReason no
      // longer smuggled there.
      expect(result.routingDelta).toMatchObject({ thing: "value" });
      expect(result.routingDelta?.["__failure_reason"]).toBeUndefined();
    }
    store.close();
  });

  test("backend fail with empty failure_reason → no failureReason field", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r3-empty", store, "n1");
    const failing: CodergenBackend = {
      async run() {
        return {
          status: "fail",
          context_updates: {},
          preferred_label: "",
          suggested_next_ids: [],
          notes: "",
          failure_reason: "",
        };
      },
    };
    const spec = makeCodergenHandler({
      node: node({ id: "n1" }),
      nextNode: "__end__",
      backend: failing,
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.outcomeStatus).toBe("fail");
      expect(result.failureReason).toBeUndefined();
    }
    store.close();
  });

  test("backend retry → transition with outcomeStatus=retry (executor consults retry-policy)", async () => {
    // Per attractor §3.5 / §3.6, retry status flows through as a
    // transition; the executor calls retryStep to decide between
    // sleep+re-dispatch, halt(max_retries_exceeded), or advance_partial.
    // handler-bridge no longer short-circuits to halt.
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r3-retry", store, "n1");
    const retrying: CodergenBackend = {
      async run() {
        return {
          status: "retry",
          context_updates: {},
          preferred_label: "",
          suggested_next_ids: [],
          notes: "",
          failure_reason: "transient",
        };
      },
    };
    const spec = makeCodergenHandler({
      node: node({ id: "n1" }),
      nextNode: "__end__",
      backend: retrying,
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") expect(result.outcomeStatus).toBe("retry");
    store.close();
  });

  test("substitutes ctx.args into node.attrs.prompt before backend.run()", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r-sub", store, "n1", {
      $ARGUMENTS: "rename foo() to bar()",
    });
    let seenPrompt: string | undefined;
    const capture: CodergenBackend = {
      async run(input) {
        seenPrompt = input.prompt;
        return ok({});
      },
    };
    const spec = makeCodergenHandler({
      node: node({ attrs: { shape: "box", prompt: "Task: $ARGUMENTS" } }),
      nextNode: "__end__",
      backend: capture,
    });
    await spec.handler(ctx);
    expect(seenPrompt).toBe("Task: rename foo() to bar()");
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

// Backend-emitted messages can theoretically exceed the 1 MiB cap when
// a tool result ships a huge blob. The bridge must neither crash the
// handler nor swallow the message silently; the contract is to spill to
// an artifact and persist a tiny placeholder so the transcript retains
// a retrievable pointer.
describe("makeCodergenHandler — oversized messages spill to artifact", () => {
  test("persistMessage on a >1 MiB message survives: placeholder + artifact", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r-big-msg", store, "n1");

    // Build an assistant message whose text is ~2 MiB — well past the cap.
    const filler = "x".repeat(MAX_MESSAGE_CONTENT_BYTES * 2);
    const backend: CodergenBackend = {
      async run(input) {
        input.persistMessage?.({
          role: "assistant",
          content: [{ type: "text", text: filler }],
          api: "anthropic" as never,
          provider: "anthropic" as never,
          model: "claude-stub",
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
        return ok({});
      },
    };

    const spec = makeCodergenHandler({ node: node({ id: "n1" }), backend });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");

    // A placeholder message should have landed on the transcript —
    // marker text, not the filler.
    const messages = store.getMessages("r-big-msg");
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const lastBlocks = (messages[messages.length - 1]!.content as { content: Array<{ text?: string }> }).content;
    const placeholderText = lastBlocks.map((b) => b.text ?? "").join("");
    expect(placeholderText).toMatch(/message too large/);
    expect(placeholderText).toMatch(/spilled to artifact/);
    expect(placeholderText).not.toContain("xxxxx"); // no leak of the giant filler

    // The spill artifact exists and holds the full serialised message.
    const spillKey = /spilled to artifact (\S+?)\]/.exec(placeholderText)?.[1];
    expect(spillKey).toBeDefined();
    const artifactBytes = store.getArtifact({
      runId: "r-big-msg",
      nodeId: "n1",
      iteration: 0,
      key: spillKey!,
    });
    expect(artifactBytes.length).toBeGreaterThan(MAX_MESSAGE_CONTENT_BYTES);

    store.close();
  });
});

describe("makeCodergenHandler — output capture + nodeOutputs substitution", () => {
  test("final assistant text lands as artifact 'output' and outputRef is on the transition", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r-cap-1", store, "plan");
    const spec = makeCodergenHandler({
      node: node({ id: "plan" }),
      nextNode: "implement",
      backend: stubBackend({ assistantText: "PLAN: 1) read 2) write" }),
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.outputRef).toBeDefined();
      expect(result.outputRef?.nodeId).toBe("plan");
      expect(result.outputRef?.key).toBe("output");
    }
    const bytes = store.getArtifact({ runId: "r-cap-1", nodeId: "plan", iteration: 0, key: "output" });
    expect(new TextDecoder().decode(bytes)).toBe("PLAN: 1) read 2) write");
    store.close();
  });

  test("multi-turn: last assistant text wins (the agent's final answer)", async () => {
    // A real agent often emits an interim assistant turn that calls a tool,
    // then a final summary turn after the tool result. Downstream nodes
    // reference the final answer, not whatever the agent muttered before
    // calling bash.
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r-cap-2", store, "implement");
    const multiTurn: CodergenBackend = {
      async run(input) {
        input.persistMessage?.({
          role: "assistant",
          content: [{ type: "text", text: "let me check…" }],
          api: "anthropic" as never,
          provider: "anthropic" as never,
          model: "claude-stub",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 1,
        });
        input.persistMessage?.({
          role: "toolResult",
          toolCallId: "x",
          toolName: "bash",
          content: [{ type: "text", text: "exit 0" }],
          isError: false,
          timestamp: 2,
        });
        input.persistMessage?.({
          role: "assistant",
          content: [{ type: "text", text: "FINAL: implementation complete" }],
          api: "anthropic" as never,
          provider: "anthropic" as never,
          model: "claude-stub",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 3,
        });
        return ok({});
      },
    };
    const spec = makeCodergenHandler({ node: node({ id: "implement" }), backend: multiTurn });
    await spec.handler(ctx);
    const text = new TextDecoder().decode(
      store.getArtifact({ runId: "r-cap-2", nodeId: "implement", iteration: 0, key: "output" }),
    );
    expect(text).toBe("FINAL: implementation complete");
    store.close();
  });

  test("no assistant turn → no outputRef, no 'output' artifact written", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r-cap-3", store, "n1");
    const spec = makeCodergenHandler({
      node: node({ id: "n1" }),
      backend: stubBackend({}), // no assistantText
    });
    const result = await spec.handler(ctx);
    if (result.kind === "transition") expect(result.outputRef).toBeUndefined();
    expect(store.getArtifactRef({ runId: "r-cap-3", nodeId: "n1", iteration: 0, key: "output" })).toBeNull();
    store.close();
  });

  test("ctx.nodeOutputs is plumbed into the rendered prompt as $<nodeId>.output", async () => {
    // This is the exact bug from run 01kqg7njj2yr0sxmbd: the review node's
    // prompt referenced `$plan.output` and `$implement.output`, both
    // substituted to empty. Without this test the whole capture+plumbing
    // change is invisible — only the integration through the executor
    // proves the bug is dead.
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow("sha", "t", "digraph{}");
    store.enqueueRun({ runId: "r-sub-no", workflowSha: "sha" });
    const ac = new AbortController();
    const tools = new handler.InMemoryToolRegistry();
    const nodeOutputs: ReadonlyMap<string, { output: string; success: boolean; timestamp: number }> = new Map([
      ["plan", { output: "PLAN: 1) read 2) write", success: true, timestamp: 0 }],
      ["implement", { output: "DIFF: ok", success: true, timestamp: 1 }],
    ]);
    const ctx = handler.buildHandlerContext({
      runId: "r-sub-no",
      nodeId: "review",
      iteration: 0,
      signal: ac.signal,
      routing: {},
      store,
      llm: handler.makeLlmClient({
        signal: ac.signal,
        call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }),
      }),
      http: handler.makeHttpClient({ signal: ac.signal }),
      tools,
      args: {},
      nodeOutputs,
      recorder: {
        recordIntent: () => {},
        recordDone: () => {},
        recordFailed: () => {},
      },
    });

    let seen: string | undefined;
    const capture: CodergenBackend = {
      async run(input) {
        seen = input.prompt;
        return ok({});
      },
    };
    const spec = makeCodergenHandler({
      node: node({ id: "review", attrs: { shape: "box", prompt: "Inputs: $plan.output | $implement.output" } }),
      backend: capture,
    });
    await spec.handler(ctx);
    expect(seen).toBe("Inputs: PLAN: 1) read 2) write | DIFF: ok");
    store.close();
  });

  test("missing prior output substitutes to '' (the existing contract for unknown nodes)", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r-sub-missing", store, "review");
    let seen: string | undefined;
    const capture: CodergenBackend = {
      async run(input) {
        seen = input.prompt;
        return ok({});
      },
    };
    const spec = makeCodergenHandler({
      node: node({ id: "review", attrs: { shape: "box", prompt: "[$plan.output]" } }),
      backend: capture,
    });
    await spec.handler(ctx);
    expect(seen).toBe("[]");
    store.close();
  });
});

describe("makeCodergenHandler — provider error → pause_provider", () => {
  test("outcome.provider_error translates to HandlerResult.kind=pause_provider", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r-prov-1", store, "n1");
    const backend: CodergenBackend = {
      async run() {
        return failProvider("Insufficient balance", { httpStatus: 402, provider: "anthropic" });
      },
    };

    const spec = makeCodergenHandler({ node: node({ id: "n1" }), backend });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("pause_provider");
    if (result.kind === "pause_provider") {
      expect(result.httpStatus).toBe(402);
      expect(result.provider).toBe("anthropic");
      expect(result.errorMessage).toBe("Insufficient balance");
    }
    store.close();
  });

  test("outcome.provider_error with httpStatus=null (network error) round-trips", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r-prov-2", store, "n1");
    const backend: CodergenBackend = {
      async run() {
        return failProvider("ECONNRESET", { httpStatus: null, provider: "anthropic" });
      },
    };

    const spec = makeCodergenHandler({ node: node({ id: "n1" }), backend });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("pause_provider");
    if (result.kind === "pause_provider") {
      expect(result.httpStatus).toBeNull();
      expect(result.errorMessage).toBe("ECONNRESET");
    }
    store.close();
  });
});

describe("makeCodergenHandler — unbounded maxMs sentinel", () => {
  test('maxMs: "unbounded" produces HandlerSpec with maxMs absent', () => {
    const spec = makeCodergenHandler({ node: node(), backend: stubBackend(), maxMs: "unbounded" });
    expect(spec.maxMs).toBeUndefined();
    expect("maxMs" in spec).toBe(false);
  });

  test("maxMs: undefined applies DEFAULT_MAX_MS (4h, regression)", () => {
    const spec = makeCodergenHandler({ node: node(), backend: stubBackend() });
    expect(spec.maxMs).toBe(4 * 60 * 60 * 1000);
  });

  test("maxMs: 60_000 propagates verbatim", () => {
    const spec = makeCodergenHandler({ node: node(), backend: stubBackend(), maxMs: 60_000 });
    expect(spec.maxMs).toBe(60_000);
  });
});
