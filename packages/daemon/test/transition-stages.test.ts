// Per-stage unit tests for the pure decision stages composed by
// planTransition. Each stage is `input data -> output data` (no IO, no
// clock, no RNG baked in) so it can be exercised with hand-built inputs.
// The end-to-end composition stays covered by transition-planner.property
// and the driven executor PBT; these pin each stage in isolation across
// the success arm, halt, pause, retarget, provider-retry, and graph=null.

import { describe, expect, test } from "bun:test";
import {
  type Edge,
  GOAL_GATE_RETRIES_KEY,
  type Graph,
  type Node,
  OPERATOR_NOTES_MAX_BYTES,
  retryCountKey,
} from "@fragua/core";
import type { HandlerResult } from "@fragua/core/handler";
import { type FactEvent, MAX_ROUTING_BYTES, type RunState, utf8ByteLength as utf8Len } from "@fragua/store";
import {
  PROVIDER_RETRY_ATTEMPT_KEY,
  PROVIDER_RETRY_CUMULATIVE_MS_KEY,
  PROVIDER_RETRY_MAX_CUMULATIVE_MS,
} from "../src/provider-retry-policy.ts";
import {
  applyBudgetGate,
  applyGoalGate,
  applyProviderRetry,
  applyRetryGate,
  buildRoutingPatch,
  computeAdvanceAppliedTo,
  type ProceedDecision,
  planTransition,
  rewriteTerminalFacts,
  selectTransitionEdge,
  type TransitionInput,
  type TurnAccounting,
} from "../src/transition-planner.ts";

function mkState(
  currentNode: string,
  routing: Record<string, unknown> = {},
  metrics?: Partial<RunState["metrics"]>,
): RunState {
  return {
    runId: "r",
    version: 1,
    status: "running",
    currentNode,
    workflowSha: "g",
    contractVersion: 1,
    routing,
    metrics: {
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      nodeCosts: {},
      ...metrics,
    },
  } as unknown as RunState;
}

const zeroAccounting: TurnAccounting = {
  turnBilled: 0,
  totalCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  lastModel: undefined,
};

function transition(overrides: Partial<Extract<HandlerResult, { kind: "transition" }>> = {}): HandlerResult {
  return { kind: "transition", tokens: 0, costUsd: 0, ...overrides };
}

function node(id: string, type: Node["type"], attrs: Record<string, unknown> = {}): Node {
  return { id, type, attrs: { label: id, ...attrs } } as Node;
}

/** A spine `start → n1 → n2 → exit` with optional attrs on the graph / n1. */
function spine(opts: { graphAttrs?: Record<string, unknown>; n1Attrs?: Record<string, unknown> } = {}): Graph {
  const nodes: Record<string, Node> = {
    start: node("start", "start"),
    n1: node("n1", "llm", opts.n1Attrs),
    n2: node("n2", "llm"),
    exit: node("exit", "exit"),
  };
  const edges: Edge[] = [
    { from: "start", to: "n1", attrs: {} },
    { from: "n1", to: "n2", attrs: {} },
    { from: "n2", to: "exit", attrs: {} },
  ];
  return { id: "g", directed: true, attrs: opts.graphAttrs ?? {}, nodes, edges };
}

const emptyDecision: ProceedDecision = {
  kind: "proceed",
  appliedSeqs: [],
  routingDelta: {},
  shouldPauseAfterDispatch: false,
} as unknown as ProceedDecision;

describe("selectTransitionEdge", () => {
  test("success arm — picks the single outgoing success edge", () => {
    const out = selectTransitionEdge({
      handlerResult: transition({ outcomeStatus: "success" }),
      graph: spine(),
      currentNode: "n1",
      accounting: zeroAccounting,
    });
    expect(out.result.kind).toBe("transition");
    expect((out.result as { nextNode?: string }).nextNode).toBe("n2");
    expect(out.pendingEdgeSelection?.edge.to).toBe("n2");
    expect(out.convertedTransitionUsage).toBeUndefined();
  });

  test("graph=null — terminal by default, no edge held", () => {
    const out = selectTransitionEdge({
      handlerResult: transition(),
      graph: null,
      currentNode: "n1",
      accounting: zeroAccounting,
    });
    expect((out.result as { nextNode?: string }).nextNode).toBe("__end__");
    expect(out.pendingEdgeSelection).toBeUndefined();
  });

  test("backfills accounting onto the cloned result without mutating input", () => {
    const input = transition();
    const out = selectTransitionEdge({
      handlerResult: input,
      graph: null,
      currentNode: "n1",
      accounting: { ...zeroAccounting, turnBilled: 7, totalCostUsd: 0.5, lastModel: "m" },
    });
    expect((out.result as { tokens: number }).tokens).toBe(7);
    expect((out.result as { costUsd: number }).costUsd).toBe(0.5);
    expect((out.result as { modelName?: string }).modelName).toBe("m");
    // The caller's handler result is never mutated.
    expect((input as { tokens: number }).tokens).toBe(0);
    expect(out.result).not.toBe(input);
  });

  test("edge_no_match — a route with no matching edge converts to a halt", () => {
    // A routing node `r` declaring routes a/b; the handler chose `nope`.
    const nodes: Record<string, Node> = {
      start: node("start", "start"),
      r: node("r", "llm", { routes: ["a", "b"] }),
      t: node("t", "llm"),
      exit: node("exit", "exit"),
    };
    const edges: Edge[] = [
      { from: "start", to: "r", attrs: {} },
      { from: "r", to: "t", attrs: { route: "a" } },
      { from: "r", to: "exit", attrs: { route: "b" } },
      { from: "t", to: "exit", attrs: {} },
    ];
    const routingGraph: Graph = { id: "g", directed: true, attrs: {}, nodes, edges };
    const out = selectTransitionEdge({
      handlerResult: transition({ route: "nope", costUsd: 0.2, tokens: 3 }),
      graph: routingGraph,
      currentNode: "r",
      accounting: zeroAccounting,
    });
    expect(out.result.kind).toBe("halt");
    expect((out.result as { reason: string }).reason).toBe("edge_no_match");
    expect(out.convertedTransitionUsage?.totalCostUsd).toBe(0.2);
    expect(out.convertedTransitionUsage?.turnBilled).toBe(3);
  });

  test("non-transition result passes through untouched", () => {
    const provider = { kind: "pause_provider", httpStatus: 429, provider: "p", errorMessage: "e" } as HandlerResult;
    const out = selectTransitionEdge({
      handlerResult: provider,
      graph: spine(),
      currentNode: "n1",
      accounting: zeroAccounting,
    });
    expect(out.result).toBe(provider);
  });
});

describe("applyBudgetGate", () => {
  test("no budget attrs — no halt, no pause, no events", () => {
    const out = applyBudgetGate({
      result: transition({ nextNode: "n2", costUsd: 0.1, inputTokens: 1 }),
      graph: spine(),
      state: mkState("n1"),
      currentNode: "n1",
      iteration: 0,
      effectiveRouting: {},
    });
    expect(out.budgetHaltDetail).toBeUndefined();
    expect(out.budgetPause).toBeUndefined();
    expect(out.observability).toEqual([]);
  });

  test("stop policy — run-cost ceiling breach yields a halt", () => {
    const out = applyBudgetGate({
      result: transition({ nextNode: "n2", costUsd: 5 }),
      graph: spine({ graphAttrs: { budget_usd: 1, budget_policy: "stop" } }),
      state: mkState("n1"),
      currentNode: "n1",
      iteration: 0,
      effectiveRouting: {},
    });
    expect(out.budgetHaltDetail).toBeDefined();
    expect(out.budgetPause).toBeUndefined();
  });

  test("pause policy — breach yields an operator-resumable pause", () => {
    const out = applyBudgetGate({
      result: transition({ nextNode: "n2", costUsd: 5 }),
      graph: spine({ graphAttrs: { budget_usd: 1, budget_policy: "pause" } }),
      state: mkState("n1"),
      currentNode: "n1",
      iteration: 0,
      effectiveRouting: {},
    });
    expect(out.budgetPause).toBeDefined();
    expect(out.budgetPause?.metric).toBe("cost");
    expect(out.budgetHaltDetail).toBeUndefined();
  });

  test("non-transition result — gate is a no-op", () => {
    const halt = { kind: "halt", reason: "error" } as HandlerResult;
    const out = applyBudgetGate({
      result: halt,
      graph: spine({ graphAttrs: { budget_usd: 1, budget_policy: "stop" } }),
      state: mkState("n1"),
      currentNode: "n1",
      iteration: 0,
      effectiveRouting: {},
    });
    expect(out.budgetHaltDetail).toBeUndefined();
    expect(out.budgetPause).toBeUndefined();
  });
});

/** A gate `g0` with goal_gate=true, a `fix` rescue node, and `exit`. */
function gateGraph(opts: { retryTarget?: string; maxRetries?: number } = {}): Graph {
  const gateAttrs: Record<string, unknown> = { goal_gate: true };
  if (opts.retryTarget !== undefined) gateAttrs["retry_target"] = opts.retryTarget;
  if (opts.maxRetries !== undefined) gateAttrs["max_retries"] = opts.maxRetries;
  const nodes: Record<string, Node> = {
    start: node("start", "start"),
    g0: node("g0", "llm", gateAttrs),
    fix: node("fix", "llm"),
    exit: node("exit", "exit"),
  };
  const edges: Edge[] = [
    { from: "start", to: "g0", attrs: {} },
    { from: "g0", to: "exit", attrs: {} },
    { from: "fix", to: "g0", attrs: {} },
  ];
  return { id: "g", directed: true, attrs: {}, nodes, edges };
}

describe("applyGoalGate", () => {
  test("retarget — a failed gate heading terminal redirects to its retry_target", () => {
    const out = applyGoalGate({
      result: transition({ nextNode: "__end__", outcomeStatus: "fail" }),
      graph: gateGraph({ retryTarget: "fix", maxRetries: 2 }),
      state: mkState("g0"),
      currentNode: "g0",
      effectiveRouting: {},
    });
    expect(out.goalGateRetargetTarget).toBe("fix");
    expect(out.goalGateRetriesPatch).toBe(1);
    expect((out.result as { nextNode?: string }).nextNode).toBe("fix");
    expect(out.observability.some((o) => o.type === "goal_gate.retarget")).toBe(true);
  });

  test("halt — a failed gate with no retry_target becomes goal_gate_unsatisfied", () => {
    const out = applyGoalGate({
      result: transition({ nextNode: "__end__", outcomeStatus: "fail" }),
      graph: gateGraph({ maxRetries: 2 }),
      state: mkState("g0"),
      currentNode: "g0",
      effectiveRouting: {},
    });
    expect(out.result.kind).toBe("halt");
    expect((out.result as { reason: string }).reason).toBe("goal_gate_unsatisfied");
    expect(out.observability.some((o) => o.type === "goal_gate.unsatisfied")).toBe(true);
  });

  test("graph=null — gate check is a no-op passthrough", () => {
    const result = transition({ nextNode: "__end__", outcomeStatus: "fail" });
    const out = applyGoalGate({
      result,
      graph: null,
      state: mkState("g0"),
      currentNode: "g0",
      effectiveRouting: {},
    });
    // Clone (never the caller's object), but value-identical — no retarget.
    expect(out.result).toEqual(result);
    expect(out.goalGateRetargetTarget).toBeUndefined();
    expect(out.observability).toEqual([]);
  });

  test("retarget — does not mutate the caller's args.result", () => {
    const result = transition({ nextNode: "__end__", outcomeStatus: "fail" });
    const out = applyGoalGate({
      result,
      graph: gateGraph({ retryTarget: "fix", maxRetries: 2 }),
      state: mkState("g0"),
      currentNode: "g0",
      effectiveRouting: {},
    });
    // The retarget lands on the returned clone, never the caller's object.
    expect((out.result as { nextNode?: string }).nextNode).toBe("fix");
    expect(out.result).not.toBe(result);
    expect((result as { nextNode?: string }).nextNode).toBe("__end__");
  });
});

describe("applyRetryGate", () => {
  test("success — resets a non-zero per-node retry counter", () => {
    const out = applyRetryGate({
      result: transition({ nextNode: "n2", outcomeStatus: "success" }),
      graph: spine(),
      state: mkState("n1", { [retryCountKey("n1")]: 3 }),
      currentNode: "n1",
      effectiveRouting: {},
      now: 1000,
      random: () => 0.5,
    });
    expect(out.retryCounterPatch).toEqual({ [retryCountKey("n1")]: 0 });
    expect(out.retryPause).toBeUndefined();
  });

  test("retry — under the cap schedules a backoff pause", () => {
    const out = applyRetryGate({
      result: transition({ outcomeStatus: "retry" }),
      graph: spine({ n1Attrs: { max_retries: 2 } }),
      state: mkState("n1"),
      currentNode: "n1",
      effectiveRouting: {},
      now: 1000,
      random: () => 0.5,
    });
    expect(out.retryPause).toBeDefined();
    expect(out.retryPause?.attempt).toBe(1);
    expect((out.result as { nextNode?: string }).nextNode).toBe("n1");
    expect(out.retryCounterPatch).toEqual({ [retryCountKey("n1")]: 1 });
    expect(out.observability.some((o) => o.type === "node.retry_scheduled")).toBe(true);
  });

  test("exhaust — at the cap yields a retries-exhausted pause", () => {
    const out = applyRetryGate({
      result: transition({ outcomeStatus: "retry" }),
      graph: spine({ n1Attrs: { max_retries: 2 } }),
      state: mkState("n1", { [retryCountKey("n1")]: 2 }),
      currentNode: "n1",
      effectiveRouting: {},
      now: 1000,
      random: () => 0.5,
    });
    expect(out.retriesExhaustedPause).toBeDefined();
    expect(out.retriesExhaustedPause?.attempts).toBe(3);
    expect(out.retryPause).toBeUndefined();
    expect(out.observability.some((o) => o.type === "node.retry_exhausted")).toBe(true);
  });

  test("graph=null — passthrough, no pause", () => {
    const result = transition({ outcomeStatus: "retry" });
    const out = applyRetryGate({
      result,
      graph: null,
      state: mkState("n1"),
      currentNode: "n1",
      effectiveRouting: {},
      now: 1000,
      random: () => 0.5,
    });
    // Clone (never the caller's object), but value-identical — no pause.
    expect(out.result).toEqual(result);
    expect(out.retryPause).toBeUndefined();
    expect(out.retriesExhaustedPause).toBeUndefined();
  });

  test("retry — does not mutate the caller's args.result", () => {
    const result = transition({ nextNode: "__end__", outcomeStatus: "retry" });
    const out = applyRetryGate({
      result,
      graph: spine({ n1Attrs: { max_retries: 2 } }),
      state: mkState("n1"),
      currentNode: "n1",
      effectiveRouting: {},
      now: 1000,
      random: () => 0.5,
    });
    // The nextNode=currentNode rewrite lands on the clone, not the input.
    expect((out.result as { nextNode?: string }).nextNode).toBe("n1");
    expect(out.result).not.toBe(result);
    expect((result as { nextNode?: string }).nextNode).toBe("__end__");
  });
});

describe("applyProviderRetry", () => {
  test("auto-retry — a 429 under the chain cap schedules a retry", () => {
    const out = applyProviderRetry({
      result: { kind: "pause_provider", httpStatus: 429, provider: "p", errorMessage: "e" },
      state: mkState("n1"),
      now: 1000,
      random: () => 0.5,
    });
    expect(out.providerRetryDecision?.kind).toBe("auto-retry");
    expect(out.providerExhausted).toBeUndefined();
  });

  test("exhausted — past the chain cap yields the exhausted sentinel", () => {
    const out = applyProviderRetry({
      result: { kind: "pause_provider", httpStatus: 429, provider: "p", errorMessage: "e" },
      state: mkState("n1", { [PROVIDER_RETRY_ATTEMPT_KEY]: 5 }),
      now: 1000,
      random: () => 0.5,
    });
    expect(out.providerExhausted).toBeDefined();
    expect(out.providerExhausted?.reason).toBe("max_attempts");
    expect(out.providerRetryDecision).toBeUndefined();
  });

  test("threads the persisted cumulative — near the cap yields max_cumulative_ms", () => {
    const out = applyProviderRetry({
      result: { kind: "pause_provider", httpStatus: 429, provider: "p", errorMessage: "e" },
      state: mkState("n1", { [PROVIDER_RETRY_CUMULATIVE_MS_KEY]: PROVIDER_RETRY_MAX_CUMULATIVE_MS - 100 }),
      now: 1000,
      random: () => 0.5,
    });
    expect(out.providerExhausted?.reason).toBe("max_cumulative_ms");
    expect(out.providerRetryDecision).toBeUndefined();
  });

  test("manual — a non-auto-retryable status is carried as a manual decision", () => {
    const out = applyProviderRetry({
      result: { kind: "pause_provider", httpStatus: 401, provider: "p", errorMessage: "e" },
      state: mkState("n1"),
      now: 1000,
      random: () => 0.5,
    });
    // Manual is the existing behaviour: stored but never drives a rewrite.
    expect(out.providerRetryDecision?.kind).toBe("manual");
    expect(out.providerExhausted).toBeUndefined();
  });

  test("non-pause_provider result — no-op", () => {
    const out = applyProviderRetry({
      result: transition({ nextNode: "n2" }),
      state: mkState("n1"),
      now: 1000,
      random: () => 0.5,
    });
    expect(out.providerRetryDecision).toBeUndefined();
    expect(out.providerExhausted).toBeUndefined();
  });
});

describe("rewriteTerminalFacts", () => {
  const started: FactEvent = { type: "fact.node_started", payload: { nodeId: "n2", pass: 0 } } as FactEvent;
  const completed: FactEvent = { type: "fact.node_completed", payload: { nodeId: "n1" } } as FactEvent;

  test("budget halt — swaps the continuation for run_terminated{budget}, keeps node_completed", () => {
    const facts = rewriteTerminalFacts({
      facts: [completed, started],
      result: transition({ nextNode: "n2" }),
      state: mkState("n1"),
      decision: emptyDecision,
      budgetHaltDetail: "run cost",
    });
    expect(facts.some((f) => f.type === "fact.node_completed")).toBe(true);
    expect(facts.some((f) => f.type === "fact.node_started")).toBe(false);
    const term = facts.find((f) => f.type === "fact.run_terminated");
    expect((term?.payload as { reason?: string }).reason).toBe("budget");
  });

  test("retry pause — strips node_started, emits run_paused{handler_retry}", () => {
    const facts = rewriteTerminalFacts({
      facts: [completed, started],
      result: transition({ nextNode: "n1" }),
      state: mkState("n1"),
      decision: emptyDecision,
      retryPause: { nodeId: "n1", attempt: 1, delayMs: 100, resumeAt: 1100, maxRetries: 2 },
    });
    expect(facts.some((f) => f.type === "fact.node_started")).toBe(false);
    const paused = facts.find((f) => f.type === "fact.run_paused");
    expect((paused?.payload as { reason?: string }).reason).toBe("handler_retry");
  });

  test("provider auto-retry — rewrites provider_error pause to provider_retry + attempt fact", () => {
    const providerPause: FactEvent = {
      type: "fact.run_paused",
      payload: { reason: "provider_error", nodeId: "n1", httpStatus: 429, provider: "p", errorMessage: "e" },
    } as FactEvent;
    const input = [completed, providerPause];
    const facts = rewriteTerminalFacts({
      facts: input,
      result: { kind: "pause_provider", httpStatus: 429, provider: "p", errorMessage: "e" },
      state: mkState("n1"),
      decision: emptyDecision,
      providerRetryDecision: { kind: "auto-retry", attempt: 1, resumeAt: 1100, delayMs: 100 },
    });
    const paused = facts.find((f) => f.type === "fact.run_paused");
    expect((paused?.payload as { reason?: string }).reason).toBe("provider_retry");
    expect(facts.some((f) => f.type === "fact.provider_retry_attempted")).toBe(true);
    // Pure: the caller's array is left untouched (no in-place facts[i]/push).
    expect(input).toEqual([completed, providerPause]);
    expect(input).toHaveLength(2);
  });

  test("operator pause — shouldPauseAfterDispatch swaps the success continuation", () => {
    const facts = rewriteTerminalFacts({
      facts: [completed, started],
      result: transition({ nextNode: "n2" }),
      state: mkState("n1"),
      decision: { ...emptyDecision, shouldPauseAfterDispatch: true } as ProceedDecision,
    });
    expect(facts.some((f) => f.type === "fact.node_started")).toBe(false);
    const paused = facts.find((f) => f.type === "fact.run_paused");
    expect((paused?.payload as { reason?: string }).reason).toBe("operator");
  });

  test("operator pause beats a same-turn retry pause — stays reason=operator, no handler_retry", () => {
    const facts = rewriteTerminalFacts({
      facts: [completed, started],
      result: transition({ nextNode: "n1" }),
      state: mkState("n1"),
      decision: { ...emptyDecision, shouldPauseAfterDispatch: true } as ProceedDecision,
      retryPause: { nodeId: "n1", attempt: 1, delayMs: 100, resumeAt: 1100, maxRetries: 2 },
    });
    const paused = facts.filter((f) => f.type === "fact.run_paused");
    expect(paused).toHaveLength(1);
    expect((paused[0]?.payload as { reason?: string }).reason).toBe("operator");
    expect(paused.some((f) => (f.payload as { reason?: string }).reason === "handler_retry")).toBe(false);
  });

  test("no sentinels — facts pass through unchanged, input array untouched", () => {
    const input = [completed, started];
    const facts = rewriteTerminalFacts({
      facts: input,
      result: transition({ nextNode: "n2" }),
      state: mkState("n1"),
      decision: emptyDecision,
    });
    expect(facts).toEqual(input);
    // Pure: returns a fresh list, never the caller's array.
    expect(facts).not.toBe(input);
    expect(input).toEqual([completed, started]);
  });
});

describe("buildRoutingPatch", () => {
  test("merges the fold delta with the per-node retry counter patch", () => {
    const patch = buildRoutingPatch({
      result: transition({ nextNode: "n1", outcomeStatus: "retry" }),
      decision: { ...emptyDecision, routingDelta: { foo: "bar" } } as ProceedDecision,
      state: mkState("n1"),
      currentNode: "n1",
      graph: spine(),
      effectiveRouting: {},
      budgetWarnedTags: [],
      retryCounterPatch: { [retryCountKey("n1")]: 1 },
    });
    expect(patch).toMatchObject({ foo: "bar", [retryCountKey("n1")]: 1 });
  });

  test("records a goal-gate outcome key for a completed gate", () => {
    const patch = buildRoutingPatch({
      result: transition({ nextNode: "exit", outcomeStatus: "success" }),
      decision: emptyDecision,
      state: mkState("g0"),
      currentNode: "g0",
      graph: gateGraph({ retryTarget: "fix" }),
      effectiveRouting: {},
      budgetWarnedTags: [],
    });
    expect(patch).toBeDefined();
    expect(Object.keys(patch ?? {}).some((k) => k.includes("g0"))).toBe(true);
  });

  test("no patches — returns undefined", () => {
    const patch = buildRoutingPatch({
      result: transition({ nextNode: "n2", outcomeStatus: "success" }),
      decision: emptyDecision,
      state: mkState("n1"),
      currentNode: "n1",
      graph: spine(),
      effectiveRouting: {},
      budgetWarnedTags: [],
    });
    expect(patch).toBeUndefined();
  });

  describe("operator gate notes", () => {
    /** start → gate(human) → n1(llm) → n2(llm) → exit. */
    function gatedSpine(): Graph {
      const nodes: Record<string, Node> = {
        start: node("start", "start"),
        gate: node("gate", "human", { routes: ["approve", "revise"] }),
        n1: node("n1", "llm"),
        n2: node("n2", "llm"),
        exit: node("exit", "exit"),
      };
      const edges: Edge[] = [
        { from: "start", to: "gate", attrs: {} },
        { from: "gate", to: "n1", attrs: { route: "approve" } },
        { from: "gate", to: "n1", attrs: { route: "revise" } },
        { from: "n1", to: "n2", attrs: {} },
        { from: "n2", to: "exit", attrs: {} },
      ];
      return { id: "g", directed: true, attrs: {}, nodes, edges };
    }
    const pendingNote = { gateNodeId: "gate", route: "revise", note: "use the v2 schema" };
    const withNotes = (notes: unknown[]): Record<string, unknown> => ({ "internal.operator_notes": notes });

    test("a human transition with operatorNote appends to internal.operator_notes", () => {
      const patch = buildRoutingPatch({
        result: transition({ nextNode: "n1", route: "revise", operatorNote: "use the v2 schema" }),
        decision: emptyDecision,
        state: mkState("gate"),
        currentNode: "gate",
        graph: gatedSpine(),
        effectiveRouting: {},
        budgetWarnedTags: [],
      });
      expect(patch?.["internal.operator_notes"]).toEqual([pendingNote]);
    });

    test("a second gate note accumulates instead of clobbering the first", () => {
      const prior = { gateNodeId: "earlier_gate", route: "approve", note: "watch the flag default" };
      const patch = buildRoutingPatch({
        result: transition({ nextNode: "n1", route: "revise", operatorNote: "use the v2 schema" }),
        decision: emptyDecision,
        state: mkState("gate"),
        currentNode: "gate",
        graph: gatedSpine(),
        effectiveRouting: withNotes([prior]),
        budgetWarnedTags: [],
      });
      expect(patch?.["internal.operator_notes"]).toEqual([prior, pendingNote]);
    });

    test("append drops the oldest note when the array exceeds its byte budget", () => {
      // 40 prior 500-char notes would blow the 8KB routing column; the cap
      // drops oldest so the newest survives.
      const prior = Array.from({ length: 40 }, (_, i) => ({
        gateNodeId: `g${i}`,
        route: "approve",
        note: "x".repeat(500),
      }));
      const patch = buildRoutingPatch({
        result: transition({ nextNode: "n1", route: "revise", operatorNote: "the newest note" }),
        decision: emptyDecision,
        state: mkState("gate"),
        currentNode: "gate",
        graph: gatedSpine(),
        effectiveRouting: withNotes(prior),
        budgetWarnedTags: [],
      });
      const notes = patch?.["internal.operator_notes"] as Array<{ note: string }>;
      expect(notes.length).toBeLessThan(41);
      expect(notes.at(-1)?.note).toBe("the newest note");
      expect(JSON.stringify(notes).length).toBeLessThanOrEqual(4096);
    });

    test("the cap is budgeted against the REST of routing, not the 4096 ceiling alone", () => {
      // The notes array is structural — `spillRoutingInputs` only moves
      // `routing.inputs` strings to the CAS — so it competes with every other key
      // for MAX_ROUTING_BYTES. A wide graph's retry counters plus a long
      // `graph.goal` plus a ceiling-legal notes array used to breach the column,
      // and the breach surfaced as a PayloadTooLargeError out of the appendFact
      // committing the gate answer.
      const bulk: Record<string, unknown> = { "graph.goal": "g".repeat(1500) };
      for (let i = 0; i < 32; i++) {
        bulk[`internal.retry_count.node_number_${i}_with_a_realistic_name`] = i;
        bulk[`goal_gates.gate_number_${i}_named`] = "success";
      }
      const prior = Array.from({ length: 20 }, (_, i) => ({
        gateNodeId: `g${i}`,
        route: "approve",
        note: "x".repeat(400),
      }));
      // Sanity: this routing genuinely has no room for a ceiling-sized array.
      expect(utf8Len(JSON.stringify(bulk)) + OPERATOR_NOTES_MAX_BYTES).toBeGreaterThan(MAX_ROUTING_BYTES);
      const patch = buildRoutingPatch({
        result: transition({ nextNode: "n1", route: "revise", operatorNote: "the newest note" }),
        decision: emptyDecision,
        state: mkState("gate"),
        currentNode: "gate",
        graph: gatedSpine(),
        effectiveRouting: { ...bulk, "internal.operator_notes": prior },
        budgetWarnedTags: [],
      });
      const notes = patch?.["internal.operator_notes"] as Array<{ note: string }>;
      // The operator's newest correction survives...
      expect(notes.at(-1)?.note).toBe("the newest note");
      // ...and the routing this patch produces fits the column it has to land in.
      const committed = { ...bulk, "internal.operator_notes": notes };
      expect(utf8Len(JSON.stringify(committed))).toBeLessThan(MAX_ROUTING_BYTES);
      // Proof the budget actually bit: the ceiling alone would have kept more.
      expect(utf8Len(JSON.stringify(notes))).toBeLessThan(OPERATOR_NOTES_MAX_BYTES);
    });

    test("an llm node completing with success consumes (clears) the notes", () => {
      const patch = buildRoutingPatch({
        result: transition({ nextNode: "n2", outcomeStatus: "success" }),
        decision: emptyDecision,
        state: mkState("n1"),
        currentNode: "n1",
        graph: gatedSpine(),
        effectiveRouting: withNotes([pendingNote]),
        budgetWarnedTags: [],
      });
      expect(patch?.["internal.operator_notes"]).toEqual([]);
    });

    test("a self-loop success clears the notes (no re-delivery next iteration)", () => {
      const patch = buildRoutingPatch({
        result: transition({ nextNode: "n1", outcomeStatus: "success" }),
        decision: emptyDecision,
        state: mkState("n1"),
        currentNode: "n1",
        graph: gatedSpine(),
        effectiveRouting: withNotes([pendingNote]),
        budgetWarnedTags: [],
      });
      expect(patch?.["internal.operator_notes"]).toEqual([]);
    });

    test("a fail outcome keeps the notes (recovery path still needs the correction)", () => {
      const patch = buildRoutingPatch({
        result: transition({ nextNode: "redo", outcomeStatus: "fail" }),
        decision: emptyDecision,
        state: mkState("n1"),
        currentNode: "n1",
        graph: gatedSpine(),
        effectiveRouting: withNotes([pendingNote]),
        budgetWarnedTags: [],
      });
      expect(patch?.["internal.operator_notes"]).toBeUndefined();
    });

    test("a retry outcome keeps the notes (the same dispatch re-delivers)", () => {
      const patch = buildRoutingPatch({
        result: transition({ nextNode: "n1", outcomeStatus: "retry" }),
        decision: emptyDecision,
        state: mkState("n1"),
        currentNode: "n1",
        graph: gatedSpine(),
        effectiveRouting: withNotes([pendingNote]),
        budgetWarnedTags: [],
      });
      expect(patch?.["internal.operator_notes"]).toBeUndefined();
    });

    test("a non-llm node advancing does not consume the notes", () => {
      const patch = buildRoutingPatch({
        result: transition({ nextNode: "n1", route: "approve" }),
        decision: emptyDecision,
        state: mkState("gate"),
        currentNode: "gate",
        graph: gatedSpine(),
        effectiveRouting: withNotes([pendingNote]),
        budgetWarnedTags: [],
      });
      expect(patch?.["internal.operator_notes"]).toBeUndefined();
    });
  });
});

describe("computeAdvanceAppliedTo", () => {
  test("empty seqs — undefined", () => {
    expect(computeAdvanceAppliedTo([])).toBeUndefined();
  });

  test("non-empty — the high-water mark", () => {
    expect(computeAdvanceAppliedTo([3, 7, 5])).toBe(7);
  });
});

describe("planTransition — goal-gate / retry interaction", () => {
  // A goal_gate node that returns outcomeStatus="retry" with NO retry edge:
  // edge selection lands terminal, the goal gate elects to retarget to its
  // retry_target, and the retry gate converts the turn into a handler_retry
  // pause (nextNode rewritten back to the node). The retry pause wins; the
  // goal-gate retarget is spurious, so its retry slot must NOT be consumed.
  function mkInput(): TransitionInput {
    const state = mkState("g0");
    return {
      state,
      decision: emptyDecision,
      graph: gateGraph({ retryTarget: "fix", maxRetries: 2 }),
      handlerResult: transition({ outcomeStatus: "retry" }),
      accounting: zeroAccounting,
      effectiveRouting: {},
      currentNode: "g0",
      iteration: 0,
      now: 1000,
      random: () => 0.5,
    } satisfies TransitionInput;
  }

  test("retry pause wins — produces handler_retry, does not consume a goal-gate slot", () => {
    const plan = planTransition(mkInput());
    const paused = plan.facts.find((f) => f.type === "fact.run_paused");
    expect((paused?.payload as { reason?: string }).reason).toBe("handler_retry");
    // No node_started for the spurious retarget target was emitted.
    expect(plan.facts.some((f) => f.type === "fact.node_started")).toBe(false);
    // The goal-gate retry slot must NOT be consumed. (GOAL_GATE_RETRIES_KEY
    // is a dotted literal key, so check membership directly rather than via
    // toHaveProperty, which would read the dots as a nested path.)
    expect(Object.keys(plan.routingPatch ?? {})).not.toContain(GOAL_GATE_RETRIES_KEY);
  });

  test("budget pause wins — does not consume a goal-gate slot", () => {
    // A goal_gate node fails (heads terminal → retarget to `fix`) AND its
    // turn breaches a pause-policy budget. rewriteTerminalFacts strips the
    // retarget target's node_started and pauses at the gate, so the bump
    // must be suppressed or the gate re-executes with an inflated counter.
    const gateAttrs: Record<string, unknown> = { goal_gate: true, retry_target: "fix", max_retries: 2 };
    const nodes: Record<string, Node> = {
      start: node("start", "start"),
      g0: node("g0", "llm", gateAttrs),
      fix: node("fix", "llm"),
      exit: node("exit", "exit"),
    };
    const edges: Edge[] = [
      { from: "start", to: "g0", attrs: {} },
      { from: "g0", to: "exit", attrs: {} },
      { from: "fix", to: "g0", attrs: {} },
    ];
    const graph: Graph = {
      id: "g",
      directed: true,
      attrs: { budget_usd: 1, budget_policy: "pause" },
      nodes,
      edges,
    };
    const plan = planTransition({
      state: mkState("g0"),
      decision: emptyDecision,
      graph,
      handlerResult: transition({ outcomeStatus: "fail", costUsd: 5 }),
      accounting: zeroAccounting,
      effectiveRouting: {},
      currentNode: "g0",
      iteration: 0,
      now: 1000,
      random: () => 0.5,
    } satisfies TransitionInput);
    const paused = plan.facts.find((f) => f.type === "fact.run_paused");
    expect((paused?.payload as { reason?: string }).reason).toBe("budget");
    // No node_started for the stripped retarget target.
    expect(plan.facts.some((f) => f.type === "fact.node_started")).toBe(false);
    // The goal-gate retry slot must NOT be consumed under a budget pause.
    expect(Object.keys(plan.routingPatch ?? {})).not.toContain(GOAL_GATE_RETRIES_KEY);
  });
});
