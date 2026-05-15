// Unit tests for the parallel handler under the sub-runs model (P2 of
// docs/proposals/parallel.md). End-to-end fan-out / fan-in flow is
// exercised by daemon-level integration tests; this file covers the
// pure-handler edges:
//
//   - Initial dispatch returns `fanout_pending` with the branch list.
//   - Collect phase (routing carries sub_run_ids) synthesises
//     `ParallelBranchResult[]` from `parentCtx.subRunOutcomes`.
//   - Empty branch list halts.
//   - Missing per-id outcome surfaces as a branch failure rather than
//     dropping the slot.

import { describe, expect, test } from "bun:test";
import { FAN_IN_VERSION } from "../../src/engine/fan-in.ts";
import { makeParallelHandler, type ParallelBranchResult } from "../../src/handler/handlers/parallel.ts";
import type { HandlerContext, SubRunOutcome, ToolRegistry } from "../../src/handler/types.ts";

const emptyRegistry: ToolRegistry = {
  get: () => {
    throw new Error("no tools");
  },
  has: () => false,
  list: () => [],
  select: () => emptyRegistry,
};

function stubCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    runId: "parent",
    nodeId: overrides.nodeId ?? "fanout",
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
      put: () => ({ runId: "parent", nodeId: "n", iteration: 0, key: "", sha256: "", sizeBytes: 0, mime: null }),
      get: () => new Uint8Array(),
      ref: () => null,
      getFrom: () => new Uint8Array(),
    },
    externalCall: async (_, fn) => fn("stub-key"),
    args: {},
    nodeOutputs: new Map(),
    subRunOutcomes: overrides.subRunOutcomes ?? new Map(),
    emit: () => {},
    withScope: () => {
      throw new Error("stubCtx: withScope not implemented");
    },
  };
}

function outcome(opts: {
  subRunId: string;
  parentNodeId: string;
  parallelIndex: number;
  finalStatus: SubRunOutcome["finalStatus"];
  costUsd?: number;
  billedTokens?: number;
  fanInScore?: number;
}): SubRunOutcome {
  const o: SubRunOutcome = {
    subRunId: opts.subRunId,
    parentNodeId: opts.parentNodeId,
    parallelIndex: opts.parallelIndex,
    finalStatus: opts.finalStatus,
    costUsd: opts.costUsd ?? 0,
    billedTokens: opts.billedTokens ?? 0,
  };
  if (opts.fanInScore !== undefined) o.fanInScore = opts.fanInScore;
  return o;
}

describe("parallel handler — sub-runs model", () => {
  test("empty children halts with a clear detail", async () => {
    const spec = makeParallelHandler({ children: [], fanInNode: "fan_in" });
    const result = await spec.handler(stubCtx());
    expect(result.kind).toBe("halt");
    if (result.kind === "halt") {
      expect(result.reason).toBe("error");
      expect(result.detail).toMatch(/has no branches/);
    }
  });

  test("initial dispatch returns fanout_pending carrying branchNodeIds + fanInNode", async () => {
    const spec = makeParallelHandler({
      children: ["alpha", "beta", "gamma"],
      fanInNode: "join",
    });
    const result = await spec.handler(stubCtx({ nodeId: "fan_out" }));
    expect(result.kind).toBe("fanout_pending");
    if (result.kind === "fanout_pending") {
      expect([...result.branchNodeIds]).toEqual(["alpha", "beta", "gamma"]);
      expect(result.fanInNode).toBe("join");
      expect(result.joinPolicy).toBe("wait_all");
    }
  });

  test("collect phase synthesises ParallelBranchResult[] from subRunOutcomes", async () => {
    const subRunIds = ["sub_a", "sub_b"];
    const outcomes = new Map<string, SubRunOutcome>([
      [
        "sub_a",
        outcome({
          subRunId: "sub_a",
          parentNodeId: "fanout",
          parallelIndex: 0,
          finalStatus: "completed",
          fanInScore: 0.9,
        }),
      ],
      [
        "sub_b",
        outcome({
          subRunId: "sub_b",
          parentNodeId: "fanout",
          parallelIndex: 1,
          finalStatus: "halted",
        }),
      ],
    ]);
    const spec = makeParallelHandler({
      children: ["alpha", "beta"],
      fanInNode: "join",
    });
    const ctx = stubCtx({
      nodeId: "fanout",
      routing: { "parallel.fanout.sub_run_ids": subRunIds },
      subRunOutcomes: outcomes,
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.nextNode).toBe("join");
      const stamped = result.routingDelta?.["parallel.fanout.results"] as ParallelBranchResult[];
      expect(stamped).toHaveLength(2);
      expect(stamped[0]).toEqual({ branchId: "alpha", status: "success", score: 0.9 });
      expect(stamped[1]).toEqual({ branchId: "beta", status: "fail" });
      expect(result.routingDelta?.["parallel.fanout.fan_in_version"]).toBe(FAN_IN_VERSION);
    }
  });

  test("collect phase surfaces missing outcomes as fail rather than dropping slots", async () => {
    const subRunIds = ["sub_a", "sub_b"];
    const outcomes = new Map<string, SubRunOutcome>([
      [
        "sub_a",
        outcome({
          subRunId: "sub_a",
          parentNodeId: "fanout",
          parallelIndex: 0,
          finalStatus: "completed",
        }),
      ],
      // sub_b deliberately omitted
    ]);
    const spec = makeParallelHandler({ children: ["alpha", "beta"], fanInNode: "join" });
    const ctx = stubCtx({
      nodeId: "fanout",
      routing: { "parallel.fanout.sub_run_ids": subRunIds },
      subRunOutcomes: outcomes,
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      const stamped = result.routingDelta?.["parallel.fanout.results"] as ParallelBranchResult[];
      expect(stamped[0]?.status).toBe("success");
      expect(stamped[1]?.status).toBe("fail");
      expect(stamped[1]?.failReason).toMatch(/without a fact.subrun_completed/);
    }
  });

  test("cancelled sub-runs map to fail (fan_in treats them as losers)", async () => {
    const outcomes = new Map<string, SubRunOutcome>([
      [
        "sub_a",
        outcome({
          subRunId: "sub_a",
          parentNodeId: "fanout",
          parallelIndex: 0,
          finalStatus: "cancelled",
        }),
      ],
    ]);
    const spec = makeParallelHandler({ children: ["alpha"], fanInNode: "join" });
    const result = await spec.handler(
      stubCtx({
        nodeId: "fanout",
        routing: { "parallel.fanout.sub_run_ids": ["sub_a"] },
        subRunOutcomes: outcomes,
      }),
    );
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      const stamped = result.routingDelta?.["parallel.fanout.results"] as ParallelBranchResult[];
      expect(stamped[0]?.status).toBe("fail");
    }
  });

  test("join_policy=first_success surfaces on fanout_pending so the executor can propagate", async () => {
    const spec = makeParallelHandler({
      children: ["alpha", "beta"],
      fanInNode: "join",
      joinPolicy: "first_success",
    });
    const result = await spec.handler(stubCtx());
    expect(result.kind).toBe("fanout_pending");
    if (result.kind === "fanout_pending") {
      expect(result.joinPolicy).toBe("first_success");
    }
  });
});
