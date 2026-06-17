// Regression: a run halted by route_not_picked (or its sibling halt
// paths route_call_not_isolated / edge_no_match) drops the halted
// turn's accrued spend from run totals. The metrics fold credits spend
// only from node-level facts (fact.node_completed / fact.node_aborted
// carry tokens+cost); these halts bypass both — handler-bridge
// translates a halt_reason outcome into `{kind:"halt"}` without
// tokens/costUsd, and the transition-planner's edge_no_match backstop
// wholesale replaces a cost-bearing transition with a bare halt — so
// fact.run_halted lands with no cost fields and run_state.metrics
// reports $0 / 0 tokens even when the turn emitted dozens of
// cost.recorded observability events. Observed live: a triage node
// burned ~36 message ordinals before halting route_not_picked with
// run_state metrics showing zero.
//
// Expected post-fix behavior mirrors the abort path
// (fact.node_aborted.partial* — see abortResultToFacts and the store
// reducer fold): the halt path must surface the partial turn spend so
// run totals and analytics stay accurate. Per AGENTS.md ground rule
// #5 the reducer must NOT fold cost.recorded directly (observability
// events bypass reducers; doing so would double-count completed
// turns) — the fix lives on the executor halt path.

import { describe, expect, test } from "bun:test";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, rig, type TestRig } from "./helpers.ts";

const ROUTING_YAML = `name: t
steps:
  triage:
    type: llm
    prompt: pick a branch
    routes:
      a: exit
      b: exit
`;

function emitTurnCosts(ctx: { emit: (type: string, payload: Record<string, unknown>) => void }): void {
  ctx.emit("cost.recorded", {
    total_tokens: 1500,
    cost_usd: 0.42,
    input_tokens: 1000,
    output_tokens: 500,
    model: "anthropic/claude-opus-4-7",
  });
  ctx.emit("cost.recorded", {
    total_tokens: 800,
    cost_usd: 0.13,
    input_tokens: 600,
    output_tokens: 200,
    model: "anthropic/claude-opus-4-7",
  });
}

async function drive(r: TestRig, runId: string): Promise<void> {
  enqueue(r, runId, "triage");
  await runOne(runId, {
    store: r.store,
    dispatcher: r.dispatcher,
    registry: new AbortRegistry(),
    tools: r.tools,
    llmCall: r.llmCall,
    maxConcurrentRuns: 1,
    maxTurnsForTesting: 10,
    leakGraceMs: 500,
    shutdownSignal: new AbortController().signal,
  });
}

interface HaltPayload {
  reason: string;
  partialTokens?: number;
  partialCostUsd?: number;
  partialInputTokens?: number;
  partialOutputTokens?: number;
}

describe("executor — halt paths that bypass node_completed/node_aborted surface partial turn spend", () => {
  test("route_not_picked halt folds the turn's cost.recorded spend into fact.run_halted and run_state.metrics", async () => {
    const r = rig({ yaml: ROUTING_YAML });
    // Mirrors what handler-bridge produces when a routing-node agent
    // ends its turn without an isolated route() call: cost.recorded
    // events were emitted along the way, then a bare halt result —
    // no tokens/costUsd on the HandlerResult.
    r.dispatcher.register(r.workflowSha, "triage", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1_000,
      handler: async (ctx) => {
        emitTurnCosts(ctx);
        return {
          kind: "halt",
          reason: "route_not_picked",
          detail: "agent ended turn without calling route()",
        };
      },
    });

    await drive(r, "halt-cost-1");

    const events = r.store.getEvents("halt-cost-1");
    const halted = events.find(
      (e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored",
    );
    expect(halted).toBeDefined();
    const p = halted!.payload as HaltPayload;
    expect(p.reason).toBe("route_not_picked");

    // The two cost.recorded events sum to 2300 tokens / $0.55 — the
    // halt fact must carry the partial turn spend (mirroring
    // fact.node_aborted.partial*) so the reducer can fold it.
    expect(p.partialTokens).toBe(2300);
    expect(p.partialCostUsd).toBeCloseTo(0.55, 6);
    expect(p.partialInputTokens).toBe(1600);
    expect(p.partialOutputTokens).toBe(700);

    // Run totals must reflect the halted turn's spend — before the fix
    // metrics report $0.0000 / 0 tokens.
    const state = r.store.getState("halt-cost-1")!;
    expect(state.status).toBe("halted");
    expect(state.metrics.totalCostUsd).toBeCloseTo(0.55, 6);
    expect(state.metrics.billedTokens).toBe(2300);
    expect(state.metrics.totalInputTokens).toBe(1600);
    expect(state.metrics.totalOutputTokens).toBe(700);
    expect(state.metrics.nodeCosts["triage"]?.costUsd).toBeCloseTo(0.55, 6);

    r.store.close();
  });

  test("route_call_not_isolated halt folds partial spend the same way", async () => {
    const r = rig({ yaml: ROUTING_YAML });
    r.dispatcher.register(r.workflowSha, "triage", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1_000,
      handler: async (ctx) => {
        emitTurnCosts(ctx);
        return {
          kind: "halt",
          reason: "route_call_not_isolated",
          detail: "route() shared an assistant response with other tool calls",
        };
      },
    });

    await drive(r, "halt-cost-2");

    const halted = r.store
      .getEvents("halt-cost-2")
      .find((e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored");
    expect(halted).toBeDefined();
    const p = halted!.payload as HaltPayload;
    expect(p.reason).toBe("route_call_not_isolated");
    expect(p.partialTokens).toBe(2300);
    expect(p.partialCostUsd).toBeCloseTo(0.55, 6);

    const state = r.store.getState("halt-cost-2")!;
    expect(state.metrics.totalCostUsd).toBeCloseTo(0.55, 6);
    expect(state.metrics.billedTokens).toBe(2300);

    r.store.close();
  });

  test("edge_no_match halt (planner-converted transition) preserves the turn's reported spend", async () => {
    const r = rig({ yaml: ROUTING_YAML });
    // The handler successfully reports its spend on a transition that
    // names a route the graph doesn't declare; the transition-planner
    // converts it into halt(edge_no_match), which today drops the
    // tokens/costUsd carried on the transition.
    r.dispatcher.register(r.workflowSha, "triage", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1_000,
      handler: async (ctx) => {
        emitTurnCosts(ctx);
        return {
          kind: "transition",
          outcomeStatus: "success",
          route: "c",
          tokens: 2300,
          costUsd: 0.55,
          inputTokens: 1600,
          outputTokens: 700,
        };
      },
    });

    await drive(r, "halt-cost-3");

    const halted = r.store
      .getEvents("halt-cost-3")
      .find((e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored");
    expect(halted).toBeDefined();
    const p = halted!.payload as HaltPayload;
    expect(p.reason).toBe("edge_no_match");
    expect(p.partialTokens).toBe(2300);
    expect(p.partialCostUsd).toBeCloseTo(0.55, 6);

    const state = r.store.getState("halt-cost-3")!;
    expect(state.metrics.totalCostUsd).toBeCloseTo(0.55, 6);
    expect(state.metrics.billedTokens).toBe(2300);

    r.store.close();
  });
});
