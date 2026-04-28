// Tests for the parallel + fan_in handlers (attractor §4.8 + §4.9).

import { describe, expect, test } from "bun:test";
import { makeFanInHandler } from "../../src/handler/handlers/fan-in.ts";
import { makeParallelHandler, type ParallelBranchResult } from "../../src/handler/handlers/parallel.ts";
import type { Handler, HandlerContext, HandlerSpec, ToolRegistry } from "../../src/handler/types.ts";

type MutableHandlerContext = HandlerContext & {
  __emitted: { type: string; payload: Record<string, unknown> }[];
};

const emptyRegistry: ToolRegistry = {
  get: () => {
    throw new Error("no tools");
  },
  has: () => false,
  list: () => [],
  select: () => emptyRegistry,
};

function stubCtx(overrides: Partial<HandlerContext> = {}): MutableHandlerContext {
  const emitted: { type: string; payload: Record<string, unknown> }[] = [];
  const base: HandlerContext = {
    runId: "r",
    nodeId: overrides.nodeId ?? "parent",
    iteration: 0,
    signal: new AbortController().signal,
    routing: overrides.routing ?? {},
    llm: { call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }) },
    http: { fetch: async () => new Response("") },
    tools: emptyRegistry,
    messages: {
      append: () => ({ ordinal: 0 }),
      recent: () => [],
      since: () => [],
    },
    artifacts: {
      put: () => ({ runId: "r", nodeId: "n", iteration: 0, key: "", sha256: "", sizeBytes: 0, mime: null }),
      get: () => new Uint8Array(),
      ref: () => null,
      getFrom: () => new Uint8Array(),
    },
    externalCall: async (_, fn) => fn("stub-key"),
    args: {},
    emit: (type, payload) => emitted.push({ type, payload }),
  };
  return Object.assign({ ...base, ...overrides }, { __emitted: emitted });
}

function handlerSpec(handler: Handler): HandlerSpec {
  return { kind: "codergen", sideEffect: "none", maxMs: 1000, handler };
}

function specReturning(
  status: "success" | "fail" | "partial_success" | "retry" | "skipped",
  score?: number,
): HandlerSpec {
  return handlerSpec(async () => ({
    kind: "transition",
    outcomeStatus: status,
    tokens: 0,
    costUsd: 0,
    ...(score !== undefined ? { routingDelta: { score } } : {}),
  }));
}

function specHalting(detail: string): HandlerSpec {
  return handlerSpec(async () => ({ kind: "halt", reason: "error", detail }));
}

function specThrowing(message: string): HandlerSpec {
  return handlerSpec(async () => {
    throw new Error(message);
  });
}

function specHitl(): HandlerSpec {
  return handlerSpec(async () => ({ kind: "yield_hitl", label: "...", options: [] }));
}

describe("makeParallelHandler — wait_all", () => {
  test("empty children → halt", async () => {
    const ctx = stubCtx();
    const spec = makeParallelHandler({
      children: [],
      fanInNode: "join",
      resolveChild: () => null,
      buildChildContext: (id, parent) => ({ ...parent, nodeId: id }),
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("halt");
  });

  test("each child's outcome lands in routing.parallel.<nodeId>.results", async () => {
    const ctx = stubCtx({ nodeId: "fork" });
    const specs: Record<string, HandlerSpec> = {
      a: specReturning("success", 10),
      b: specReturning("fail"),
      c: specReturning("partial_success", 5),
    };
    const spec = makeParallelHandler({
      children: ["a", "b", "c"],
      fanInNode: "join",
      resolveChild: (id) => specs[id] ?? null,
      buildChildContext: (id, parent) => ({ ...parent, nodeId: id, iteration: 0 }),
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind !== "transition") return;
    expect(result.nextNode).toBe("join");
    const results = result.routingDelta?.["parallel.fork.results"] as ParallelBranchResult[] | undefined;
    expect(results).toHaveLength(3);
    const byId = Object.fromEntries((results ?? []).map((r) => [r.branchId, r]));
    expect(byId["a"]?.status).toBe("success");
    expect(byId["a"]?.score).toBe(10);
    expect(byId["b"]?.status).toBe("fail");
    expect(byId["c"]?.status).toBe("partial_success");
    expect(byId["c"]?.score).toBe(5);
  });

  test("unresolvable child → branch status=fail with reason", async () => {
    const ctx = stubCtx({ nodeId: "fork" });
    const spec = makeParallelHandler({
      children: ["ghost"],
      fanInNode: "join",
      resolveChild: () => null,
      buildChildContext: (id, parent) => ({ ...parent, nodeId: id }),
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind !== "transition") return;
    const results = result.routingDelta?.["parallel.fork.results"] as ParallelBranchResult[];
    expect(results[0]?.status).toBe("fail");
    expect(results[0]?.failReason).toContain("no dispatchable HandlerSpec");
  });

  test("child throw → branch status=fail with error message", async () => {
    const ctx = stubCtx({ nodeId: "fork" });
    const spec = makeParallelHandler({
      children: ["boom"],
      fanInNode: "join",
      resolveChild: () => specThrowing("boom"),
      buildChildContext: (id, parent) => ({ ...parent, nodeId: id }),
    });
    const result = await spec.handler(ctx);
    if (result.kind !== "transition") throw new Error("expected transition");
    const r = (result.routingDelta?.["parallel.fork.results"] as ParallelBranchResult[])[0];
    expect(r?.status).toBe("fail");
    expect(r?.failReason).toBe("boom");
  });

  test("child yield_hitl → branch status=fail with documented reason", async () => {
    const ctx = stubCtx({ nodeId: "fork" });
    const spec = makeParallelHandler({
      children: ["hitl_branch"],
      fanInNode: "join",
      resolveChild: () => specHitl(),
      buildChildContext: (id, parent) => ({ ...parent, nodeId: id }),
    });
    const result = await spec.handler(ctx);
    if (result.kind !== "transition") throw new Error("expected transition");
    const r = (result.routingDelta?.["parallel.fork.results"] as ParallelBranchResult[])[0];
    expect(r?.status).toBe("fail");
    expect(r?.failReason).toContain("HITL inside parallel not supported");
  });

  test("child halt is surfaced as status=fail with halt detail", async () => {
    const ctx = stubCtx({ nodeId: "fork" });
    const spec = makeParallelHandler({
      children: ["h"],
      fanInNode: "join",
      resolveChild: () => specHalting("budget exceeded"),
      buildChildContext: (id, parent) => ({ ...parent, nodeId: id }),
    });
    const result = await spec.handler(ctx);
    if (result.kind !== "transition") throw new Error("expected transition");
    const r = (result.routingDelta?.["parallel.fork.results"] as ParallelBranchResult[])[0];
    expect(r?.status).toBe("fail");
    expect(r?.failReason).toBe("budget exceeded");
  });

  test("emit records parallel.completed with branch statuses", async () => {
    const ctx = stubCtx({ nodeId: "fork" });
    const specs: Record<string, HandlerSpec> = {
      a: specReturning("success"),
      b: specReturning("fail"),
    };
    const spec = makeParallelHandler({
      children: ["a", "b"],
      fanInNode: "join",
      resolveChild: (id) => specs[id] ?? null,
      buildChildContext: (id, parent) => ({ ...parent, nodeId: id }),
    });
    await spec.handler(ctx);
    const evt = ctx.__emitted.find((e) => e.type === "parallel.completed");
    expect(evt).toBeTruthy();
    expect(evt?.payload["parallelNodeId"]).toBe("fork");
    expect(evt?.payload["joinPolicy"]).toBe("wait_all");
  });
});

describe("makeParallelHandler — first_success", () => {
  test("returns as soon as one branch reports success", async () => {
    const ctx = stubCtx({ nodeId: "fork" });
    const slowFail = handlerSpec(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { kind: "transition" as const, outcomeStatus: "fail" as const, tokens: 0, costUsd: 0 };
    });
    const fastSuccess = handlerSpec(async () => ({
      kind: "transition" as const,
      outcomeStatus: "success" as const,
      tokens: 0,
      costUsd: 0,
    }));
    const specs: Record<string, HandlerSpec> = { slow: slowFail, fast: fastSuccess };
    const spec = makeParallelHandler({
      children: ["slow", "fast"],
      fanInNode: "join",
      joinPolicy: "first_success",
      resolveChild: (id) => specs[id] ?? null,
      buildChildContext: (id, parent) => ({ ...parent, nodeId: id }),
    });
    const result = await spec.handler(ctx);
    if (result.kind !== "transition") throw new Error("expected transition");
    const results = result.routingDelta?.["parallel.fork.results"] as ParallelBranchResult[];
    const fast = results.find((r) => r.branchId === "fast");
    expect(fast?.status).toBe("success");
  });
});

describe("makeFanInHandler", () => {
  test("no routing entry → halt", async () => {
    const ctx = stubCtx({ nodeId: "join" });
    const spec = makeFanInHandler({ parallelNodeId: "fork" });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("halt");
  });

  test("heuristic picks highest-ranked branch and surfaces winner in routing", async () => {
    const ctx = stubCtx({
      nodeId: "join",
      routing: {
        "parallel.fork.results": [
          { branchId: "a", status: "fail" },
          { branchId: "b", status: "success", score: 3 },
          { branchId: "c", status: "success", score: 7 },
        ],
      },
    });
    const spec = makeFanInHandler({ parallelNodeId: "fork" });
    const result = await spec.handler(ctx);
    if (result.kind !== "transition") throw new Error("expected transition");
    expect(result.outcomeStatus).toBe("success");
    expect(result.routingDelta?.["fan_in.join.winner"]).toBe("c");
    expect(result.routingDelta?.["fan_in.join.all_failed"]).toBe(false);
  });

  test("all-fail input → outcome=fail but still emits a winner (lex-smallest)", async () => {
    const ctx = stubCtx({
      nodeId: "join",
      routing: {
        "parallel.fork.results": [
          { branchId: "b", status: "fail" },
          { branchId: "a", status: "fail" },
        ],
      },
    });
    const spec = makeFanInHandler({ parallelNodeId: "fork" });
    const result = await spec.handler(ctx);
    if (result.kind !== "transition") throw new Error("expected transition");
    expect(result.outcomeStatus).toBe("fail");
    expect(result.routingDelta?.["fan_in.join.all_failed"]).toBe(true);
    expect(result.routingDelta?.["fan_in.join.winner"]).toBe("a");
  });

  test("malformed entries are filtered out; valid ones still rank", async () => {
    const ctx = stubCtx({
      nodeId: "join",
      routing: {
        "parallel.fork.results": [
          null,
          "not-an-object",
          { branchId: 42, status: "success" }, // wrong branchId type
          { status: "success" }, // missing branchId
          { branchId: "good", status: "success", score: 1 },
        ],
      },
    });
    const spec = makeFanInHandler({ parallelNodeId: "fork" });
    const result = await spec.handler(ctx);
    if (result.kind !== "transition") throw new Error("expected transition");
    expect(result.routingDelta?.["fan_in.join.winner"]).toBe("good");
  });

  test("emits fan_in.completed with the ranked order", async () => {
    const ctx = stubCtx({
      nodeId: "join",
      routing: {
        "parallel.fork.results": [
          { branchId: "c", status: "success", score: 1 },
          { branchId: "a", status: "success", score: 10 },
          { branchId: "b", status: "success", score: 5 },
        ],
      },
    });
    const spec = makeFanInHandler({ parallelNodeId: "fork" });
    await spec.handler(ctx);
    const evt = ctx.__emitted.find((e) => e.type === "fan_in.completed");
    expect(evt?.payload["rankedOrder"]).toEqual(["a", "b", "c"]);
  });
});
