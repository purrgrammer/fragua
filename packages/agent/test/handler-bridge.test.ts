import { describe, expect, test } from "bun:test";
import type { LlmBackend, Node, OutcomeStatus } from "@fragua/core";
import { failProvider, ok } from "@fragua/core";
import * as handler from "@fragua/core/handler";
import { MAX_MESSAGE_CONTENT_BYTES, SqliteStore } from "@fragua/store";
import fc from "fast-check";
import { makeLlmHandler } from "../src/handler-bridge.ts";

function node(overrides: Partial<Node> = {}): Node {
  return {
    id: overrides.id ?? "n1",
    type: "llm",
    attrs: {
      prompt: "What is 2+2?",
      ...(overrides.attrs ?? {}),
    },
  };
}

function stubBackend(
  emitScript: {
    totalTokens?: number;
    costUsd?: number;
    model?: string;
    assistantText?: string;
    toolText?: string;
  } = {},
): LlmBackend {
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
      return ok({ notes: "done" });
    },
  };
}

async function ctxFor(
  runId: string,
  store: SqliteStore,
  nodeId: string,
  args: Readonly<{ inputs?: Record<string, string> }> = {},
): Promise<handler.HandlerContext> {
  store.saveWorkflow("sha", "t", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n");
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

describe("makeLlmHandler", () => {
  test("runs the backend and returns a transition with tokens/cost/model", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r1", store, "n1");
    const spec = makeLlmHandler({
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
    }
    store.close();
  });

  test("appends assistant + tool messages into ctx.messages", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r2", store, "n1");
    const spec = makeLlmHandler({
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
    const failing: LlmBackend = {
      async run() {
        return {
          status: "fail",
          notes: "",
          failure_reason: "provider unreachable",
        };
      },
    };
    const spec = makeLlmHandler({
      node: node({ id: "n1" }),
      nextNode: "__end__",
      backend: failing,
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.outcomeStatus).toBe("fail");
      expect(result.failureReason).toBe("provider unreachable");
    }
    store.close();
  });

  test("backend fail with empty failure_reason → no failureReason field", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r3-empty", store, "n1");
    const failing: LlmBackend = {
      async run() {
        return {
          status: "fail",
          notes: "",
          failure_reason: "",
        };
      },
    };
    const spec = makeLlmHandler({
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
    const retrying: LlmBackend = {
      async run() {
        return {
          status: "retry",
          notes: "",
          failure_reason: "transient",
        };
      },
    };
    const spec = makeLlmHandler({
      node: node({ id: "n1" }),
      nextNode: "__end__",
      backend: retrying,
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") expect(result.outcomeStatus).toBe("retry");
    store.close();
  });

  test("substitutes ${{ inputs.x }} from ctx.args.inputs before backend.run()", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r-inputs", store, "n1", {
      inputs: { ticket: "BUG-42", env: "prod" },
    });
    let seenPrompt: string | undefined;
    const capture: LlmBackend = {
      async run(input) {
        seenPrompt = input.prompt;
        return ok({});
      },
    };
    const spec = makeLlmHandler({
      node: node({ attrs: { prompt: "Fix ${{ inputs.ticket }} on ${{ inputs.env }}" } }),
      nextNode: "__end__",
      backend: capture,
    });
    await spec.handler(ctx);
    expect(seenPrompt).toBe("Fix BUG-42 on prod");
    store.close();
  });

  test("unbound ${{ inputs.x }} collapses to '' rather than leaking the literal", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r-empty", store, "n1");
    let seenPrompt: string | undefined;
    const capture: LlmBackend = {
      async run(input) {
        seenPrompt = input.prompt;
        return ok({});
      },
    };
    const spec = makeLlmHandler({
      node: node({ attrs: { prompt: "[${{ inputs.missing }}]" } }),
      nextNode: "__end__",
      backend: capture,
    });
    await spec.handler(ctx);
    expect(seenPrompt).toBe("[]");
    expect(seenPrompt?.includes("${{ inputs.missing }}")).toBe(false);
    store.close();
  });

  test("dedups duplicate system + user rows on resumed dispatch (same content as prior tail)", async () => {
    // Re-dispatching the same node on resume (operator pause &
    // resume, raise & resume, provider-error auto-resume) writes
    // a byte-identical system prompt (deterministic from node
    // attrs) and re-passes the same input prompt to pi-agent,
    // which emits it as a fresh user message. Without dedup the
    // messages table grows N × {system, user} rows per N resume
    // cycles. handler-bridge's persistMessage wrapper memos the
    // last persisted system/user for this (run, nodeId) and
    // drops byte-identical re-writes; pi-agent's transcript
    // semantics aren't affected because the dropped rows would
    // have been duplicates the next priorMessages load already
    // covers via the prior bracket's row.
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow("sha", "t", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n");
    store.enqueueRun({ runId: "run-dedup", workflowSha: "sha" });
    const ac = new AbortController();
    const buildCtx = (): handler.HandlerContext =>
      handler.buildHandlerContext({
        runId: "run-dedup",
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
        tools: new handler.InMemoryToolRegistry(),
        args: {},
        recorder: { recordIntent: () => {}, recordDone: () => {}, recordFailed: () => {} },
      });

    const SYS = "you are a careful reviewer";
    const USR = "review the diff";
    let runCount = 0;
    const backend: LlmBackend = {
      async run(input) {
        runCount += 1;
        input.persistMessage?.({ role: "system", content: SYS, timestamp: Date.now() });
        input.persistMessage?.({ role: "user", content: USR, timestamp: Date.now() });
        return ok({});
      },
    };

    // Dispatch 1: fresh — both rows land.
    const spec = makeLlmHandler({ node: node({ id: "review" }), nextNode: "__end__", backend });
    await spec.handler(buildCtx());
    expect(runCount).toBe(1);
    let rows = store.getMessages("run-dedup", { nodeId: "review" }).map((r) => r.content.role);
    expect(rows).toEqual(["system", "user"]);

    // Dispatch 2 (resume): same system + user content → dedup
    // skips both; messages table unchanged.
    await spec.handler(buildCtx());
    expect(runCount).toBe(2);
    rows = store.getMessages("run-dedup", { nodeId: "review" }).map((r) => r.content.role);
    expect(rows).toEqual(["system", "user"]);

    // Dispatch 3 with a CHANGED system prompt → persists the new
    // one; the user prompt (still identical) is dropped.
    const NEW_SYS = "you are an even more careful reviewer";
    const backendChangedSys: LlmBackend = {
      async run(input) {
        input.persistMessage?.({ role: "system", content: NEW_SYS, timestamp: Date.now() });
        input.persistMessage?.({ role: "user", content: USR, timestamp: Date.now() });
        return ok({});
      },
    };
    const spec3 = makeLlmHandler({ node: node({ id: "review" }), nextNode: "__end__", backend: backendChangedSys });
    await spec3.handler(buildCtx());
    rows = store.getMessages("run-dedup", { nodeId: "review" }).map((r) => r.content.role);
    expect(rows).toEqual(["system", "user", "system"]);
    store.close();
  });

  test("dedup is length-independent: a >50-turn transcript before resume still dedups system + user", async () => {
    // The system + seed-user are the FIRST rows of a dispatch. An earlier
    // tail-bounded memo (last 50 rows only) missed them once a node ran
    // more than 50 turns before pausing, so the resume re-seeded a
    // duplicate system + user mid-transcript. Regression: the memo must
    // find the head rows regardless of how long the transcript grew.
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow("sha", "t", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n");
    store.enqueueRun({ runId: "run-long", workflowSha: "sha" });
    const ac = new AbortController();
    const buildCtx = (): handler.HandlerContext =>
      handler.buildHandlerContext({
        runId: "run-long",
        nodeId: "analyze",
        iteration: 0,
        signal: ac.signal,
        routing: {},
        store,
        llm: handler.makeLlmClient({
          signal: ac.signal,
          call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }),
        }),
        http: handler.makeHttpClient({ signal: ac.signal }),
        tools: new handler.InMemoryToolRegistry(),
        args: {},
        recorder: { recordIntent: () => {}, recordDone: () => {}, recordFailed: () => {} },
      });

    const SYS = "you are an analyst";
    const USR = "analyze the repo";
    const FILLER = 60;
    let dispatch = 0;
    const backend: LlmBackend = {
      async run(input) {
        dispatch += 1;
        input.persistMessage?.({ role: "system", content: SYS, timestamp: Date.now() });
        input.persistMessage?.({ role: "user", content: USR, timestamp: Date.now() });
        if (dispatch === 1) {
          for (let i = 0; i < FILLER; i++) {
            input.persistMessage?.({
              role: "toolResult",
              toolCallId: `f${i}`,
              toolName: "stub",
              content: [{ type: "text", text: `filler ${i}` }],
              isError: false,
              timestamp: i,
            });
          }
        }
        return ok({});
      },
    };

    const spec = makeLlmHandler({ node: node({ id: "analyze" }), nextNode: "__end__", backend });
    await spec.handler(buildCtx()); // dispatch 1: system + user + 60 filler rows
    await spec.handler(buildCtx()); // dispatch 2 (resume): same system + user → must dedup

    const roles = store.getMessages("run-long", { nodeId: "analyze" }).map((r) => r.content.role);
    expect(roles.filter((r) => r === "system")).toHaveLength(1);
    expect(roles.filter((r) => r === "user")).toHaveLength(1);
    expect(roles.filter((r) => r === "toolResult")).toHaveLength(FILLER);
    store.close();
  });
});

// Regression / property suite for "llm routing belongs to the edge
// selector, not the handler". Before this was locked in, the daemon's
// codergenFactory forwarded `first = outbound[0]` to makeLlmHandler,
// which meant every llm call forced its nextNode to whichever edge
// happened to appear first — bypassing the selector and
// sending e.g. `outcome=success` runs down an `outcome=fail` branch
// just because that branch was declared first.
//
// The invariants these tests lock:
//   (I1) No `nextNode` option → HandlerResult.nextNode is undefined (selector decides).
//   (I2) Setting `nextNode` option propagates for transition-spec paths.
describe("makeLlmHandler — routing delegation invariants", () => {
  test("(I1) no nextNode option + no override → result.nextNode undefined", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r-inv-1", store, "n1");
    const backend: LlmBackend = {
      async run() {
        return ok({});
      },
    };
    const spec = makeLlmHandler({ node: node({ id: "n1" }), backend });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") expect(result.nextNode).toBeUndefined();
    store.close();
  });

  test("(I2) nextNode option alone propagates when no override is set", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r-inv-2", store, "n1");
    const backend: LlmBackend = {
      async run() {
        return ok({});
      },
    };
    const spec = makeLlmHandler({ node: node({ id: "n1" }), nextNode: "legacy-target", backend });
    const result = await spec.handler(ctx);
    if (result.kind === "transition") expect(result.nextNode).toBe("legacy-target");
    store.close();
  });

  test("property: (I1) holds across arbitrary outcomeStatus", async () => {
    const statuses: OutcomeStatus[] = ["success", "fail", "retry"];
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...statuses), async (status) => {
        const store = new SqliteStore({ path: ":memory:" });
        try {
          const ctx = await ctxFor(`r-prop-${Math.random()}`, store, "n1");
          const backend: LlmBackend = {
            async run() {
              return { status, notes: "" };
            },
          };
          const spec = makeLlmHandler({ node: node({ id: "n1" }), backend });
          const result = await spec.handler(ctx);
          // Invariant: no forced nextNode when the caller didn't supply one.
          // The executor's edge selector must be free to pick.
          if (result.kind === "transition") {
            expect(result.nextNode).toBeUndefined();
            expect(result.outcomeStatus).toBe(status);
          }
        } finally {
          store.close();
        }
      }),
      { numRuns: 30 },
    );
  });
});

// Backend-emitted messages can theoretically exceed the 1 MiB cap when
// a tool result ships a huge blob. The bridge must neither crash the
// handler nor swallow the message silently; the contract is to spill to
// an artifact and persist a tiny placeholder so the transcript retains
// a retrievable pointer.
describe("makeLlmHandler — oversized messages spill to artifact", () => {
  test("persistMessage on a >1 MiB message survives: placeholder + artifact", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r-big-msg", store, "n1");

    // Build an assistant message whose text is ~2 MiB — well past the cap.
    const filler = "x".repeat(MAX_MESSAGE_CONTENT_BYTES * 2);
    const backend: LlmBackend = {
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

    const spec = makeLlmHandler({ node: node({ id: "n1" }), backend });
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

describe("makeLlmHandler — provider error → pause_provider", () => {
  test("outcome.provider_error translates to HandlerResult.kind=pause_provider", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r-prov-1", store, "n1");
    const backend: LlmBackend = {
      async run() {
        return failProvider("Insufficient balance", { httpStatus: 402, provider: "anthropic" });
      },
    };

    const spec = makeLlmHandler({ node: node({ id: "n1" }), backend });
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
    const backend: LlmBackend = {
      async run() {
        return failProvider("ECONNRESET", { httpStatus: null, provider: "anthropic" });
      },
    };

    const spec = makeLlmHandler({ node: node({ id: "n1" }), backend });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("pause_provider");
    if (result.kind === "pause_provider") {
      expect(result.httpStatus).toBeNull();
      expect(result.errorMessage).toBe("ECONNRESET");
    }
    store.close();
  });
});

describe("makeLlmHandler — priorMessages thread loading", () => {
  // Captures the priorMessages the backend received so the test can assert
  // on what was hydrated for the shared thread.
  function capturingBackend(): { calls: Array<readonly unknown[]>; backend: LlmBackend } {
    const calls: Array<readonly unknown[]> = [];
    const backend: LlmBackend = {
      async run(input) {
        calls.push(input.priorMessages ?? []);
        return ok({ notes: "done" });
      },
    };
    return { calls, backend };
  }

  // Seeds the messages table directly so the test exercises the hydration
  // path without running a real backend twice.
  function seed(store: SqliteStore, runId: string, nodeId: string, content: unknown): void {
    store.appendMessage(runId, {
      nodeId,
      iteration: 0,
      content: content as never,
    });
  }

  test("thread_id matching a single node_id still scopes to that node only", async () => {
    // When thread_id equals an exact node_id, the loader takes the
    // node-scoped branch (no fallback).
    const store = new SqliteStore({ path: ":memory:" });
    const { calls, backend } = capturingBackend();
    const ctx = await ctxFor("r2", store, "implement");

    seed(store, "r2", "implement", {
      role: "assistant",
      content: [{ type: "text", text: "PLAN_REALISED" }],
      timestamp: 1,
    });
    seed(store, "r2", "other", {
      role: "assistant",
      content: [{ type: "text", text: "should not appear" }],
      timestamp: 2,
    });

    const spec = makeLlmHandler({
      node: node({ id: "implement", attrs: { prompt: "…", thread_id: "implement" } }),
      backend,
    });

    await spec.handler(ctx);

    const prior = calls[0] as ReadonlyArray<{ role: string; content?: unknown[] }>;
    expect(prior).toHaveLength(1);
    expect(JSON.stringify(prior)).toContain("PLAN_REALISED");
    expect(JSON.stringify(prior)).not.toContain("should not appear");
    store.close();
  });

  test("unthreaded node rehydrates its own (nodeId, iteration) transcript on resume; a new iteration starts fresh", async () => {
    // A node with no explicit `thread:` gets a synthetic per-(nodeId,
    // iteration) thread, so a resumed dispatch of the same entry sees its
    // mid-flight transcript instead of an empty agent — while a fresh loop
    // pass (next iteration) still starts clean.
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow("sha", "t", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n");
    store.enqueueRun({ runId: "r-syn", workflowSha: "sha" });
    const calls: Array<readonly unknown[]> = [];
    const ac = new AbortController();
    const buildCtx = (iteration: number): handler.HandlerContext =>
      handler.buildHandlerContext({
        runId: "r-syn",
        nodeId: "work",
        iteration,
        signal: ac.signal,
        routing: {},
        store,
        llm: handler.makeLlmClient({
          signal: ac.signal,
          call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }),
        }),
        http: handler.makeHttpClient({ signal: ac.signal }),
        tools: new handler.InMemoryToolRegistry(),
        args: {},
        recorder: { recordIntent: () => {}, recordDone: () => {}, recordFailed: () => {} },
      });

    const backend: LlmBackend = {
      async run(input) {
        calls.push(input.priorMessages ?? []);
        input.persistMessage?.({
          role: "assistant",
          content: [{ type: "text", text: "PARTIAL_WORK" }],
          api: "anthropic" as never,
          provider: "anthropic" as never,
          model: "stub",
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
    const spec = makeLlmHandler({ node: node({ id: "work" }), nextNode: "__end__", backend });

    await spec.handler(buildCtx(0)); // dispatch 1, iter 0: fresh
    await spec.handler(buildCtx(0)); // dispatch 2, iter 0: resume → rehydrates iter-0 transcript
    await spec.handler(buildCtx(1)); // iter 1: a new loop pass → fresh again

    expect(calls[0]).toEqual([]); // first dispatch has nothing prior
    expect(JSON.stringify(calls[1])).toContain("PARTIAL_WORK"); // resume sees its own transcript
    expect(calls[2]).toEqual([]); // a new iteration starts clean
    store.close();
  });
});

describe("makeLlmHandler — unbounded maxMs sentinel", () => {
  test('maxMs: "unbounded" produces HandlerSpec with maxMs absent', () => {
    const spec = makeLlmHandler({ node: node(), backend: stubBackend(), maxMs: "unbounded" });
    expect(spec.maxMs).toBeUndefined();
    expect("maxMs" in spec).toBe(false);
  });

  test("maxMs: undefined applies DEFAULT_MAX_MS (4h, regression)", () => {
    const spec = makeLlmHandler({ node: node(), backend: stubBackend() });
    expect(spec.maxMs).toBe(4 * 60 * 60 * 1000);
  });

  test("maxMs: 60_000 propagates verbatim", () => {
    const spec = makeLlmHandler({ node: node(), backend: stubBackend(), maxMs: 60_000 });
    expect(spec.maxMs).toBe(60_000);
  });
});
