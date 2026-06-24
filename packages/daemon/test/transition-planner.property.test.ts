// Property-based tests over the pure planTransition (executor PBT Phase 4).
//
// planTransition is referentially transparent, so its invariants become
// properties over generated TransitionInput — checked in-memory, no store, no
// driven run. Inputs pair a validator-clean graph + a chosen currentNode (the
// tier-1 slice, arbitraries/graph.ts) with a generated handler result, fold
// decision, and accounting. The §5 invariants (SPEC §4 / the proposal):
//   A  purity + no input mutation  (the referential-transparency claim)
//   B  at most one terminal fact
//   C  node_started never coexists with a pause/terminal fact (swap correctness)
//   D  spend conservation — node_completed survives the pause swaps
//   E  advanceAppliedTo = max(appliedSeqs) | undefined
//   F  yield_human → run_paused_human (the HITL pause)

import { describe, expect, test } from "bun:test";
import { type Edge, type Graph, type Node, type NodeAttrs, retryCountKey, validate } from "@fragua/core";
import type { HandlerResult } from "@fragua/core/handler";
import type { RunState } from "@fragua/store";
import fc from "fast-check";
import { pbtRuns } from "../../../test/pbt-runs.ts";
import { planTransition, type TransitionInput } from "../src/transition-planner.ts";
import { arbGraphWithCurrentNode } from "./arbitraries/graph.ts";
import {
  arbAccounting,
  arbHandlerResult,
  arbProceedDecision,
  arbYieldHuman,
  DEFAULT_ROUTES,
} from "./transition-arbitraries.ts";

// planTransition reads only currentNode / routing / workflowSha / metrics off
// RunState; the rest is cast away (mirrors result-to-facts.route.test).
function mkState(currentNode: string): RunState {
  return {
    runId: "r",
    version: 1,
    status: "running",
    currentNode,
    workflowSha: "g",
    contractVersion: 1,
    routing: {},
    metrics: { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, nodeCosts: {} },
  } as unknown as RunState;
}

// Handler-result, accounting, and proceed-decision arbitraries live in
// `./transition-arbitraries.ts` — the richer, shared input space (every
// HandlerResult arm with its full field surface, both the edge-selection
// `nextNode`-unset and verbatim-`nextNode` paths). Graph + state stay here
// because they bind the current node.

/** Compose a full TransitionInput from a (parameterizable) handler-result
 * arbitrary, so HITL-only properties can narrow to yield_human. */
function inputArb(resultArb: fc.Arbitrary<HandlerResult>): fc.Arbitrary<TransitionInput> {
  return fc
    .tuple(
      arbGraphWithCurrentNode,
      resultArb,
      arbProceedDecision,
      arbAccounting,
      fc.nat({ max: 1e9 }),
      fc.nat({ max: 10 }),
    )
    .map(([gn, handlerResult, decision, accounting, now, iteration]) => {
      const state = mkState(gn.nodeId);
      return {
        state,
        decision,
        graph: gn.graph,
        handlerResult,
        accounting,
        effectiveRouting: { ...state.routing, ...decision.routingDelta },
        currentNode: gn.nodeId,
        iteration,
        now,
        random: () => 0.5,
      } satisfies TransitionInput;
    });
}

const arbInput = inputArb(arbHandlerResult());

/** Map a fact to its pre-collapse disposition string (fact-taxonomy.md §3.1–3.2)
 *  so the type-string assertions below keep distinguishing
 *  completed/errored/aborted and human-pause faithfully. */
const legacyFactType = (f: { type: string; payload: unknown }): string => {
  if (f.type === "fact.run_terminated") {
    const s = (f.payload as { status?: string }).status;
    return s === "completed" ? "fact.run_completed" : s === "aborted" ? "fact.run_cancelled" : "fact.run_halted";
  }
  if (f.type === "fact.run_paused" && (f.payload as { reason?: string }).reason === "human")
    return "fact.run_paused_human";
  return f.type;
};
const factTypes = (plan: { facts: { type: string; payload: unknown }[] }): Set<string> =>
  new Set(plan.facts.map(legacyFactType));

// HITL answer / route-case: a routing-llm or human node `r` whose route
// `r{chosen}` the re-dispatched handler picks (simulating the operator's
// answer — the handler returns a transition carrying that route). r0 always
// targets a downstream node `t` so t stays reachable + exit-reachable; the
// rest target exit or t. Built directly (guaranteed route node + known target,
// no filtering) and validated clean in the property body.
const arbRouteCase = fc
  .record({
    nodeType: fc.constantFrom<"llm" | "human">("llm", "human"),
    routeCount: fc.integer({ min: 1, max: 3 }),
    chosen: fc.nat({ max: 2 }),
    extraToExit: fc.array(fc.boolean(), { minLength: 2, maxLength: 2 }),
  })
  .map(({ nodeType, routeCount, chosen, extraToExit }) => {
    const m = routeCount;
    const targets = Array.from({ length: m }, (_, j) => (j === 0 ? "t" : extraToExit[j - 1] ? "exit" : "t"));
    const routes = Array.from({ length: m }, (_, j) => `r${j}`);
    const rAttrs: NodeAttrs = nodeType === "human" ? { label: "r", routes, text: "choose" } : { label: "r", routes };
    const nodes: Record<string, Node> = {
      start: { id: "start", type: "start", attrs: { label: "start" } },
      r: { id: "r", type: nodeType === "human" ? "human" : "llm", attrs: rAttrs },
      t: { id: "t", type: "llm", attrs: { label: "t" } },
      exit: { id: "exit", type: "exit", attrs: { label: "exit" } },
    };
    const edges: Edge[] = [
      { from: "start", to: "r", attrs: {} },
      ...routes.map((rt, j) => ({ from: "r", to: targets[j]!, attrs: { route: rt } })),
      { from: "t", to: "exit", attrs: {} },
    ];
    const graph: Graph = { id: "g", directed: true, attrs: {}, nodes, edges };
    return { graph, route: `r${chosen % m}`, expectedTarget: targets[chosen % m]! };
  });

// Budget breach: a 2-node spine (n1 → n2 → exit) with a run-level cost ceiling
// the dispatched node n1 overspends. n1's transition is non-terminal (→ n2), so
// node_started is emitted then swapped by the budget gate — the one
// planTransition rewrite branch the broad inputs reach only incidentally.
// policy "stop" halts, "pause" pauses; both keep node_completed.
const arbBudgetCase = fc
  .record({
    policy: fc.constantFrom<"stop" | "pause">("stop", "pause"),
    budgetUsd: fc.double({ min: 0.01, max: 1, noNaN: true }),
    overspend: fc.double({ min: 1.01, max: 10, noNaN: true }),
  })
  .map(({ policy, budgetUsd, overspend }) => {
    const graph: Graph = {
      id: "g",
      directed: true,
      attrs: { budget_usd: budgetUsd, budget_policy: policy },
      nodes: {
        start: { id: "start", type: "start", attrs: { label: "start" } },
        n1: { id: "n1", type: "llm", attrs: { label: "n1" } },
        n2: { id: "n2", type: "llm", attrs: { label: "n2" } },
        exit: { id: "exit", type: "exit", attrs: { label: "exit" } },
      },
      edges: [
        { from: "start", to: "n1", attrs: {} },
        { from: "n1", to: "n2", attrs: {} },
        { from: "n2", to: "exit", attrs: {} },
      ],
    };
    return { graph, policy, costUsd: budgetUsd * overspend };
  });

// Shared zero-spend fixtures for the directly-constructed swap inputs below.
const ZERO_ACCOUNTING: TransitionInput["accounting"] = {
  turnBilled: 0,
  totalCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  lastModel: undefined,
};
const PROCEED_NOOP = {
  kind: "proceed",
  routingDelta: {},
  shouldPause: false,
  shouldPauseAfterDispatch: false,
  appliedSeqs: [],
  dropped: [],
} as TransitionInput["decision"];

/** A run-level budget spine (n1 → n2 → exit) under a declared ceiling/policy —
 * the same shape arbBudgetCase builds, factored so the budget-swap properties
 * can pick the policy. */
function budgetGraph(budgetUsd: number, policy: "stop" | "pause"): Graph {
  return {
    id: "g",
    directed: true,
    attrs: { budget_usd: budgetUsd, budget_policy: policy },
    nodes: {
      start: { id: "start", type: "start", attrs: { label: "start" } },
      n1: { id: "n1", type: "llm", attrs: { label: "n1" } },
      n2: { id: "n2", type: "llm", attrs: { label: "n2" } },
      exit: { id: "exit", type: "exit", attrs: { label: "exit" } },
    },
    edges: [
      { from: "start", to: "n1", attrs: {} },
      { from: "n1", to: "n2", attrs: {} },
      { from: "n2", to: "exit", attrs: {} },
    ],
  };
}

/** A breaching success transition on n1 of a budget spine. */
function mkBudgetInput(graph: Graph, node: string, costUsd: number): TransitionInput {
  return {
    state: mkState(node),
    decision: PROCEED_NOOP,
    graph,
    handlerResult: { kind: "transition", outcomeStatus: "success", tokens: 0, costUsd },
    accounting: ZERO_ACCOUNTING,
    effectiveRouting: {},
    currentNode: node,
    iteration: 0,
    now: 0,
    random: () => 0.5,
  };
}

/** A `outcomeStatus:"retry"` transition on a `max_retries`-bearing node, with
 * the per-node retry counter pre-seeded in routing — so the retry-policy block
 * lands on either the retry-pause (prior < max) or the retries-exhausted
 * (prior ≥ max) swap. Both keep node_completed. */
function mkRetryInput(node: string, maxRetries: number, priorRetries: number): TransitionInput {
  const graph: Graph = {
    id: "g",
    directed: true,
    attrs: {},
    nodes: {
      start: { id: "start", type: "start", attrs: { label: "start" } },
      [node]: { id: node, type: "llm", attrs: { label: node, max_retries: maxRetries } },
      exit: { id: "exit", type: "exit", attrs: { label: "exit" } },
    },
    edges: [
      { from: "start", to: node, attrs: {} },
      { from: node, to: "exit", attrs: {} },
    ],
  };
  const routing = { [retryCountKey(node)]: priorRetries };
  const state = { ...mkState(node), routing } as RunState;
  return {
    state,
    decision: PROCEED_NOOP,
    graph,
    handlerResult: { kind: "transition", outcomeStatus: "retry", tokens: 100, costUsd: 0.5 },
    accounting: ZERO_ACCOUNTING,
    effectiveRouting: routing,
    currentNode: node,
    iteration: 0,
    now: 0,
    random: () => 0.5,
  };
}

// SPEND-PRESERVATION input space: each arm constructs a transition whose
// node_completed (real spend) is at risk of being dropped by a fact-list swap,
// tagged with the swap fact the planner must emit. The four arms are the four
// swaps: retry-pause, retries-exhausted, budget-pause, budget-halt.
interface SwapCase {
  input: TransitionInput;
  swap: { type: string; reason: string };
}
const arbRetryPauseSwap: fc.Arbitrary<SwapCase> = fc
  .record({ maxRetries: fc.integer({ min: 1, max: 4 }), prior: fc.nat({ max: 3 }) })
  .map(({ maxRetries, prior }) => ({
    input: mkRetryInput("impl", maxRetries, prior % maxRetries),
    swap: { type: "fact.run_paused", reason: "handler_retry" },
  }));
const arbRetriesExhaustedSwap: fc.Arbitrary<SwapCase> = fc
  .record({ maxRetries: fc.nat({ max: 3 }), extra: fc.nat({ max: 3 }) })
  .map(({ maxRetries, extra }) => ({
    input: mkRetryInput("impl", maxRetries, maxRetries + extra),
    swap: { type: "fact.run_paused", reason: "max_retries" },
  }));
const arbBudgetSwap = (policy: "stop" | "pause"): fc.Arbitrary<SwapCase> =>
  fc
    .record({
      budgetUsd: fc.double({ min: 0.01, max: 1, noNaN: true }),
      overspend: fc.double({ min: 1.01, max: 10, noNaN: true }),
    })
    .map(({ budgetUsd, overspend }) => ({
      input: mkBudgetInput(budgetGraph(budgetUsd, policy), "n1", budgetUsd * overspend),
      swap:
        policy === "stop"
          ? { type: "fact.run_terminated", reason: "budget" }
          : { type: "fact.run_paused", reason: "budget" },
    }));
const arbSwapCase: fc.Arbitrary<SwapCase> = fc.oneof(
  arbRetryPauseSwap,
  arbRetriesExhaustedSwap,
  arbBudgetSwap("pause"),
  arbBudgetSwap("stop"),
);

// Stop-policy budget breach: `evaluateBudget` reports shouldHalt = true (a
// breach over a declared run ceiling with budget_policy="stop"), so the plan
// must NOT advance — no node_started rides.
const arbBudgetHaltCase = fc
  .record({
    budgetUsd: fc.double({ min: 0.01, max: 1, noNaN: true }),
    overspend: fc.double({ min: 1.01, max: 10, noNaN: true }),
  })
  .map(({ budgetUsd, overspend }) => mkBudgetInput(budgetGraph(budgetUsd, "stop"), "n1", budgetUsd * overspend));

describe("planTransition — properties", () => {
  test("A: pure — same input ⇒ equal plan, and handlerResult is never mutated", () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const before = structuredClone(input.handlerResult);
        const a = planTransition(input);
        const b = planTransition(input);
        expect(a).toEqual(b);
        expect(input.handlerResult).toEqual(before);
      }),
      { numRuns: pbtRuns(1000) },
    );
  });

  test("B: at most one terminal fact (run_completed | run_halted)", () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const plan = planTransition(input);
        const terminals = plan.facts.filter(
          (f) =>
            (f.type === "fact.run_terminated" && (f.payload as { status?: string }).status === "completed") ||
            (f.type === "fact.run_terminated" && (f.payload as { status?: string }).status === "errored"),
        );
        expect(terminals.length).toBeLessThanOrEqual(1);
      }),
      { numRuns: pbtRuns(1000) },
    );
  });

  test("C: node_started never coexists with a pause or terminal fact", () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const t = factTypes(planTransition(input));
        if (t.has("fact.node_started")) {
          expect(t.has("fact.run_paused")).toBe(false);
          expect(t.has("fact.run_paused_human")).toBe(false);
          expect(t.has("fact.run_halted")).toBe(false);
          expect(t.has("fact.run_completed")).toBe(false);
        }
      }),
      { numRuns: pbtRuns(1000) },
    );
  });

  // Spend conservation: a transition spends (it ran), so when the planner
  // swaps its node_started for a pause the node_completed accounting must
  // survive. Gated on a *transition* input: the same run_paused{max_retries}
  // reason also arises from a handler-returned halt{max_retries_exceeded}
  // (translated by result-to-facts), which never completed a node — that
  // provenance carries no node_completed and is correctly excluded here.
  // (budget is listed for when Phase 2 graphs declare budget_usd; it can't
  // fire on Phase 1 graphs.)
  test("D: spend conservation — a transition's pause swap keeps fact.node_completed", () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        if (input.handlerResult.kind !== "transition") return;
        const plan = planTransition(input);
        const swapPause = plan.facts.some(
          (f) =>
            f.type === "fact.run_paused" &&
            ["operator", "handler_retry", "max_retries", "budget"].includes(
              (f.payload as { reason?: string }).reason ?? "",
            ),
        );
        if (swapPause) {
          expect(plan.facts.some((f) => f.type === "fact.node_completed")).toBe(true);
        }
      }),
      { numRuns: pbtRuns(1000) },
    );
  });

  test("E: advanceAppliedTo = max(appliedSeqs) | undefined", () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const plan = planTransition(input);
        const seqs = input.decision.appliedSeqs;
        if (seqs.length === 0) {
          expect(plan.advanceAppliedTo).toBeUndefined();
        } else {
          let max = seqs[0]!;
          for (const s of seqs) if (s > max) max = s;
          expect(plan.advanceAppliedTo).toBe(max);
        }
      }),
      { numRuns: pbtRuns(1000) },
    );
  });

  test("F: yield_human ⇒ run_paused_human, no node_started, no terminal (the HITL pause)", () => {
    fc.assert(
      fc.property(inputArb(arbYieldHuman(DEFAULT_ROUTES)), (input) => {
        const t = factTypes(planTransition(input));
        expect(t.has("fact.run_paused_human")).toBe(true);
        expect(t.has("fact.node_started")).toBe(false);
        expect(t.has("fact.run_completed")).toBe(false);
        expect(t.has("fact.run_halted")).toBe(false);
      }),
      { numRuns: pbtRuns(500) },
    );
  });

  test("G: HITL answer — a transition's route selects the matching route edge", () => {
    fc.assert(
      fc.property(arbRouteCase, ({ graph, route, expectedTarget }) => {
        expect(validate(graph)).toEqual([]); // the constructed route graph is clean
        const input: TransitionInput = {
          state: mkState("r"),
          decision: {
            kind: "proceed",
            routingDelta: {},
            shouldPause: false,
            shouldPauseAfterDispatch: false,
            appliedSeqs: [],
            dropped: [],
          } as TransitionInput["decision"],
          graph,
          handlerResult: { kind: "transition", outcomeStatus: "success", route, tokens: 0, costUsd: 0 },
          accounting: {
            turnBilled: 0,
            totalCostUsd: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheReadTokens: 0,
            totalCacheWriteTokens: 0,
            lastModel: undefined,
          },
          effectiveRouting: {},
          currentNode: "r",
          iteration: 0,
          now: 0,
          random: () => 0.5,
        };
        const plan = planTransition(input);
        const completed = plan.facts.find((f) => f.type === "fact.node_completed");
        expect(completed).toBeDefined();
        const payload = completed!.payload as { nextNode?: string; route?: string };
        // selectEdge's route-case resolved nextNode to the chosen route's edge target.
        expect(payload.nextNode).toBe(expectedTarget);
        expect(payload.route).toBe(route);
      }),
      { numRuns: pbtRuns(500) },
    );
  });

  test("EXACTLY-ONE-TERMINAL: facts carry at most one fact.run_terminated (any status)", () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const terminals = planTransition(input).facts.filter((f) => f.type === "fact.run_terminated");
        expect(terminals.length).toBeLessThanOrEqual(1);
      }),
      { numRuns: pbtRuns(1000) },
    );
  });

  test("NO-ADVANCE-PAST-BUDGET: a budget breach with shouldHalt=true emits no fact.node_started", () => {
    fc.assert(
      fc.property(arbBudgetHaltCase, (input) => {
        const plan = planTransition(input);
        // Precondition: the stop-policy breach did halt (shouldHalt was true).
        const halted = plan.facts.some(
          (f) => f.type === "fact.run_terminated" && (f.payload as { reason?: string }).reason === "budget",
        );
        expect(halted).toBe(true);
        // Invariant: a halt never advances — no node_started.
        expect(plan.facts.some((f) => f.type === "fact.node_started")).toBe(false);
      }),
      { numRuns: pbtRuns(300) },
    );
  });

  test("SPEND-PRESERVATION: every halt/pause swap keeps fact.node_completed (spend never dropped)", () => {
    fc.assert(
      fc.property(arbSwapCase, ({ input, swap }) => {
        const plan = planTransition(input);
        // The swap actually fired (the property would be vacuous otherwise).
        const swapFired = plan.facts.some(
          (f) => f.type === swap.type && (f.payload as { reason?: string }).reason === swap.reason,
        );
        expect(swapFired).toBe(true);
        // The retrying/breaching node's spend survives the fact-list rewrite.
        expect(plan.facts.some((f) => f.type === "fact.node_completed")).toBe(true);
      }),
      { numRuns: pbtRuns(400) },
    );
  });

  test("H: budget breach — stop halts / pause pauses, both keep node_completed", () => {
    fc.assert(
      fc.property(arbBudgetCase, ({ graph, policy, costUsd }) => {
        expect(validate(graph)).toEqual([]); // the constructed budget graph is clean
        const input: TransitionInput = {
          state: mkState("n1"),
          decision: {
            kind: "proceed",
            routingDelta: {},
            shouldPause: false,
            shouldPauseAfterDispatch: false,
            appliedSeqs: [],
            dropped: [],
          } as TransitionInput["decision"],
          graph,
          handlerResult: { kind: "transition", outcomeStatus: "success", tokens: 0, costUsd },
          accounting: {
            turnBilled: 0,
            totalCostUsd: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheReadTokens: 0,
            totalCacheWriteTokens: 0,
            lastModel: undefined,
          },
          effectiveRouting: {},
          currentNode: "n1",
          iteration: 0,
          now: 0,
          random: () => 0.5,
        };
        const plan = planTransition(input);
        const t = factTypes(plan);
        // The breaching node ran; its node_completed (spend) survives the swap.
        expect(t.has("fact.node_completed")).toBe(true);
        expect(t.has("fact.node_started")).toBe(false);
        const breached = (type: string): boolean =>
          plan.facts.some((f) => legacyFactType(f) === type && (f.payload as { reason?: string }).reason === "budget");
        if (policy === "stop") expect(breached("fact.run_halted")).toBe(true);
        else expect(breached("fact.run_paused")).toBe(true);
      }),
      { numRuns: pbtRuns(300) },
    );
  });
});
