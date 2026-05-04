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
    nodeOutputs: new Map(),
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

describe("makeParallelHandler — branch lifecycle events", () => {
  test("emits fact.node_started before and fact.node_completed after each branch with parentNodeId/parallelIndex", async () => {
    const ctx = stubCtx({ nodeId: "fork" });
    const specs: Record<string, HandlerSpec> = {
      a: specReturning("success"),
      b: specReturning("fail"),
    };
    const spec = makeParallelHandler({
      children: ["a", "b"],
      fanInNode: "join",
      resolveChild: (id) => specs[id] ?? null,
      buildChildContext: (id, parent) => ({ ...parent, nodeId: id, iteration: 0 }),
    });
    await spec.handler(ctx);

    const starts = ctx.__emitted.filter((e) => e.type === "fact.node_started");
    const completes = ctx.__emitted.filter((e) => e.type === "fact.node_completed");
    expect(starts).toHaveLength(2);
    expect(completes).toHaveLength(2);

    // Per-branch fence: started precedes completed for the same branch id.
    for (const branchId of ["a", "b"]) {
      const startIdx = ctx.__emitted.findIndex(
        (e) => e.type === "fact.node_started" && e.payload["nodeId"] === branchId,
      );
      const completeIdx = ctx.__emitted.findIndex(
        (e) => e.type === "fact.node_completed" && e.payload["nodeId"] === branchId,
      );
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(completeIdx).toBeGreaterThan(startIdx);
    }

    const startA = starts.find((e) => e.payload["nodeId"] === "a");
    const startB = starts.find((e) => e.payload["nodeId"] === "b");
    expect(startA?.payload["parentNodeId"]).toBe("fork");
    expect(startA?.payload["parallelIndex"]).toBe(0);
    expect(startA?.payload["iteration"]).toBe(0);
    expect(startB?.payload["parentNodeId"]).toBe("fork");
    expect(startB?.payload["parallelIndex"]).toBe(1);

    const completeA = completes.find((e) => e.payload["nodeId"] === "a");
    const completeB = completes.find((e) => e.payload["nodeId"] === "b");
    expect(completeA?.payload["parentNodeId"]).toBe("fork");
    expect(completeA?.payload["parallelIndex"]).toBe(0);
    expect(completeA?.payload["outcomeStatus"]).toBe("success");
    expect(completeA?.payload["nextNode"]).toBe("join");
    expect(completeB?.payload["outcomeStatus"]).toBe("fail");
    expect(completeB?.payload["parallelIndex"]).toBe(1);
  });

  test("fact.node_completed carries optional score and outputRef from the branch handler result", async () => {
    const ctx = stubCtx({ nodeId: "fork" });
    const lensA: HandlerSpec = handlerSpec(async () => ({
      kind: "transition" as const,
      outcomeStatus: "success" as const,
      tokens: 12,
      costUsd: 0.01,
      routingDelta: { score: 7 },
      outputRef: {
        runId: "r",
        nodeId: "lens_a",
        iteration: 0,
        key: "output",
        sha256: "deadbeef",
        sizeBytes: 4,
        mime: null,
      },
    }));
    const spec = makeParallelHandler({
      children: ["lens_a"],
      fanInNode: "synth",
      resolveChild: () => lensA,
      buildChildContext: (id, parent) => ({ ...parent, nodeId: id, iteration: 0 }),
    });
    await spec.handler(ctx);

    const completed = ctx.__emitted.find((e) => e.type === "fact.node_completed" && e.payload["nodeId"] === "lens_a");
    expect(completed).toBeTruthy();
    expect(completed?.payload["score"]).toBe(7);
    expect(completed?.payload["tokens"]).toBe(12);
    expect(completed?.payload["costUsd"]).toBe(0.01);
    // outputRef shape mirrors selectNodeOutputRefs SQL contract: "<refNodeId>:<key>".
    expect(completed?.payload["outputRef"]).toBe("lens_a:output");
  });

  test("$<branchId>.output is addressable: outputRef on branch fact.node_completed uses the branch nodeId so getNodeOutputs would key by branch", async () => {
    const ctx = stubCtx({ nodeId: "fork" });
    const branchSpec = (branchId: string): HandlerSpec =>
      handlerSpec(async () => ({
        kind: "transition" as const,
        outcomeStatus: "success" as const,
        tokens: 0,
        costUsd: 0,
        outputRef: {
          runId: "r",
          nodeId: branchId,
          iteration: 0,
          key: "output",
          sha256: "sha",
          sizeBytes: 1,
          mime: null,
        },
      }));
    const specs: Record<string, HandlerSpec> = {
      lens_correctness: branchSpec("lens_correctness"),
      lens_security: branchSpec("lens_security"),
    };
    const spec = makeParallelHandler({
      children: ["lens_correctness", "lens_security"],
      fanInNode: "synth",
      resolveChild: (id) => specs[id] ?? null,
      buildChildContext: (id, parent) => ({ ...parent, nodeId: id, iteration: 0 }),
    });
    await spec.handler(ctx);

    const completes = ctx.__emitted.filter((e) => e.type === "fact.node_completed");
    expect(completes).toHaveLength(2);
    for (const ev of completes) {
      const branchId = ev.payload["nodeId"] as string;
      const outputRef = ev.payload["outputRef"] as string;
      // Substitution contract: selectNodeOutputRefs splits on ":" and uses
      // the prefix as the addressable nodeId. Branches must surface their
      // own id so $<branchId>.output resolves downstream of fan_in.
      expect(outputRef.startsWith(`${branchId}:`)).toBe(true);
    }
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
