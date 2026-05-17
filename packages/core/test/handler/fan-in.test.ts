// Tests for makeFanInHandler — both the heuristic path (no evaluator)
// and the LLM path (evaluator.kind="llm").

import { describe, expect, test } from "bun:test";
import type { NodeOutput } from "../../src/engine/substitution.ts";
import {
  type LlmFanInDelegate,
  type LlmFanInInput,
  type LlmFanInResult,
  makeFanInHandler,
} from "../../src/handler/handlers/fan-in.ts";
import type { HandlerContext, ToolRegistry } from "../../src/handler/types.ts";

const emptyRegistry: ToolRegistry = {
  get: () => {
    throw new Error("no tools");
  },
  has: () => false,
  list: () => [],
  select: () => emptyRegistry,
};

function stubCtx(
  overrides: {
    nodeId?: string;
    routing?: Record<string, unknown>;
    nodeOutputs?: ReadonlyMap<string, NodeOutput>;
    emitCb?: (type: string, payload: Record<string, unknown>) => void;
  } = {},
): HandlerContext {
  const _emittedEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    runId: "run-1",
    nodeId: overrides.nodeId ?? "join",
    iteration: 0,
    signal: new AbortController().signal,
    routing: overrides.routing ?? {},
    llm: { call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }) },
    http: { fetch: async () => new Response("") },
    tools: emptyRegistry,
    messages: { append: () => ({ ordinal: 0 }), recent: () => [], since: () => [] },
    artifacts: {
      put: () => ({ runId: "run-1", nodeId: "join", iteration: 0, key: "", sha256: "", sizeBytes: 0, mime: null }),
      get: () => new Uint8Array(),
      ref: () => null,
      getFrom: () => new Uint8Array(),
    },
    externalCall: async (_, fn) => fn("stub-key"),
    args: {},
    nodeOutputs: overrides.nodeOutputs ?? new Map(),
    subRunOutcomes: new Map(),
    emit: overrides.emitCb ?? (() => {}),
    withScope: () => {
      throw new Error("withScope not implemented in this test");
    },
  };
}

function candidateResults(list: Array<{ branchId: string; status: string; score?: number }>) {
  return list;
}

// ── Heuristic path ───────────────────────────────────────────────────────

describe("makeFanInHandler heuristic path", () => {
  test("picks the success branch as winner and writes fan_in.<id>.winner to routing", async () => {
    const spec = makeFanInHandler({ parallelNodeId: "fanout" });
    const ctx = stubCtx({
      nodeId: "join",
      routing: {
        "parallel.fanout.results": candidateResults([
          { branchId: "branch_a", status: "fail" },
          { branchId: "branch_b", status: "success" },
        ]),
      },
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.routingDelta?.["fan_in.join.winner"]).toBe("branch_b");
      expect(result.routingDelta?.["fan_in.join.all_failed"]).toBe(false);
      expect(result.tokens).toBe(0);
      expect(result.costUsd).toBe(0);
    }
  });

  test("prompt unset emits evaluator:'heuristic' on fan_in.completed", async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const spec = makeFanInHandler({ parallelNodeId: "fanout" });
    const ctx = stubCtx({
      nodeId: "join",
      routing: {
        "parallel.fanout.results": candidateResults([{ branchId: "branch_a", status: "success" }]),
      },
      emitCb: (type, payload) => emitted.push({ type, payload }),
    });
    await spec.handler(ctx);
    const completed = emitted.find((e) => e.type === "fan_in.completed");
    expect(completed).toBeDefined();
    expect(completed?.payload["evaluator"]).toBe("heuristic");
    expect(completed?.payload["tokens"]).toBe(0);
    expect(completed?.payload["costUsd"]).toBe(0);
  });

  test("all-failed sets allFailed flag and returns fail outcomeStatus", async () => {
    const spec = makeFanInHandler({ parallelNodeId: "fanout" });
    const ctx = stubCtx({
      nodeId: "join",
      routing: {
        "parallel.fanout.results": candidateResults([
          { branchId: "branch_a", status: "fail" },
          { branchId: "branch_b", status: "fail" },
        ]),
      },
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.outcomeStatus).toBe("fail");
      expect(result.routingDelta?.["fan_in.join.all_failed"]).toBe(true);
    }
  });

  test("missing routing results halts", async () => {
    const spec = makeFanInHandler({ parallelNodeId: "fanout" });
    const ctx = stubCtx({ nodeId: "join", routing: {} });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("halt");
    if (result.kind === "halt") {
      expect(result.detail).toMatch(/no results under routing\.parallel\.fanout\.results/);
    }
  });
});

// ── LLM path ────────────────────────────────────────────────────────────

describe("makeFanInHandler LLM path", () => {
  function makeDelegate(resultFn: (input: LlmFanInInput) => LlmFanInResult): {
    delegate: LlmFanInDelegate;
    calls: LlmFanInInput[];
  } {
    const calls: LlmFanInInput[] = [];
    const delegate: LlmFanInDelegate = async (input) => {
      calls.push(input);
      return resultFn(input);
    };
    return { delegate, calls };
  }

  const baseRouting = {
    "parallel.fanout.results": candidateResults([
      { branchId: "branch_a", status: "success", score: 0.5 },
      { branchId: "branch_b", status: "success", score: 0.8 },
    ]),
    "parallel.fanout.fan_in_version": 1,
  };

  const baseNodeOutputs = new Map<string, NodeOutput>([
    ["branch_a", { success: true, output: "output of branch A", timestamp: 1000 }],
    ["branch_b", { success: true, output: "output of branch B", timestamp: 1001 }],
  ]);

  test("delegate winner becomes the routing winner", async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const { delegate } = makeDelegate(() => ({
      winner: "branch_b",
      tokens: 42,
      costUsd: 0.01,
      modelName: "claude-stub",
    }));
    const spec = makeFanInHandler({
      parallelNodeId: "fanout",
      evaluator: {
        kind: "llm",
        prompt: "pick the better branch",
        delegate,
        nodeAttrs: {},
      },
    });
    const ctx = stubCtx({
      nodeId: "join",
      routing: baseRouting,
      nodeOutputs: baseNodeOutputs,
      emitCb: (type, payload) => emitted.push({ type, payload }),
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.routingDelta?.["fan_in.join.winner"]).toBe("branch_b");
      expect(result.tokens).toBe(42);
      expect(result.costUsd).toBe(0.01);
      expect(result.modelName).toBe("claude-stub");
    }
    const completed = emitted.find((e) => e.type === "fan_in.completed");
    expect(completed?.payload["evaluator"]).toBe("llm");
    expect(completed?.payload["winner"]).toBe("branch_b");
    expect(completed?.payload["tokens"]).toBe(42);
  });

  test("delegate winner outside candidate set halts with structured detail", async () => {
    const { delegate } = makeDelegate(() => ({
      winner: "ghost_branch",
      tokens: 5,
      costUsd: 0.001,
    }));
    const spec = makeFanInHandler({
      parallelNodeId: "fanout",
      evaluator: {
        kind: "llm",
        prompt: "pick",
        delegate,
        nodeAttrs: {},
      },
    });
    const ctx = stubCtx({ nodeId: "join", routing: baseRouting, nodeOutputs: baseNodeOutputs });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("halt");
    if (result.kind === "halt") {
      expect(result.detail).toMatch(/fan_in_llm_picked_unknown_branch/);
      expect(result.detail).toMatch(/ghost_branch/);
      expect(result.detail).toMatch(/branch_a/);
      expect(result.detail).toMatch(/branch_b/);
    }
  });

  test("delegate returning a failure halts with the failure reason in detail", async () => {
    const { delegate } = makeDelegate(() => ({
      failure: {
        reason: "fan_in_llm_emit_missing" as const,
        detail: "no WINNER: <branchId> line found in the LLM reply",
      },
    }));
    const spec = makeFanInHandler({
      parallelNodeId: "fanout",
      evaluator: {
        kind: "llm",
        prompt: "pick",
        delegate,
        nodeAttrs: {},
      },
    });
    const ctx = stubCtx({ nodeId: "join", routing: baseRouting, nodeOutputs: baseNodeOutputs });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("halt");
    if (result.kind === "halt") {
      expect(result.detail).toMatch(/fan_in_llm_emit_missing/);
    }
  });

  test("delegate receives branchOutputs resolved from nodeOutputs", async () => {
    const capturedInputs: LlmFanInInput[] = [];
    const delegate: LlmFanInDelegate = async (input) => {
      capturedInputs.push(input);
      return { winner: "branch_a", tokens: 0, costUsd: 0 };
    };
    const spec = makeFanInHandler({
      parallelNodeId: "fanout",
      evaluator: {
        kind: "llm",
        prompt: "choose",
        delegate,
        nodeAttrs: {},
      },
    });
    const ctx = stubCtx({
      nodeId: "join",
      routing: {
        "parallel.fanout.results": candidateResults([{ branchId: "branch_a", status: "success" }]),
      },
      nodeOutputs: new Map([["branch_a", { success: true, output: "branch A text", timestamp: 100 }]]),
    });
    await spec.handler(ctx);
    expect(capturedInputs).toHaveLength(1);
    const inp = capturedInputs[0]!;
    expect(inp.branchOutputs.get("branch_a")).toBe("branch A text");
    expect(inp.prompt).toBe("choose");
  });

  test("prompt is substituted before being passed to delegate", async () => {
    const capturedInputs: LlmFanInInput[] = [];
    const delegate: LlmFanInDelegate = async (input) => {
      capturedInputs.push(input);
      return { winner: "branch_a", tokens: 0, costUsd: 0 };
    };
    const spec = makeFanInHandler({
      parallelNodeId: "fanout",
      evaluator: {
        kind: "llm",
        prompt: "goal is: $ARGUMENTS",
        delegate,
        nodeAttrs: {},
      },
    });
    const ctx: HandlerContext = {
      ...stubCtx({
        nodeId: "join",
        routing: {
          "parallel.fanout.results": candidateResults([{ branchId: "branch_a", status: "success" }]),
        },
        nodeOutputs: new Map([["branch_a", { success: true, output: "", timestamp: 0 }]]),
      }),
      args: { $ARGUMENTS: "fix the bug" },
    };
    await spec.handler(ctx);
    expect(capturedInputs[0]?.prompt).toBe("goal is: fix the bug");
  });

  test("LLM spec has no maxMs (unbounded — inherits run signal)", () => {
    const spec = makeFanInHandler({
      parallelNodeId: "fanout",
      evaluator: {
        kind: "llm",
        prompt: "choose",
        delegate: async () => ({ winner: "x", tokens: 0, costUsd: 0 }),
        nodeAttrs: {},
      },
    });
    expect((spec as { maxMs?: number }).maxMs).toBeUndefined();
  });

  test("heuristic spec has default 1-second maxMs", () => {
    const spec = makeFanInHandler({ parallelNodeId: "fanout" });
    expect((spec as { maxMs?: number }).maxMs).toBe(1_000);
  });
});
