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
import { type Edge, type Graph, type Node, type NodeAttrs, validate } from "@fragua/core";
import type { HandlerResult } from "@fragua/core/handler";
import type { RunState } from "@fragua/store";
import fc from "fast-check";
import { planTransition, type TransitionInput } from "../src/transition-planner.ts";
import { arbGraphWithCurrentNode } from "./arbitraries/graph.ts";

// planTransition reads only currentNode / routing / workflowSha / metrics off
// RunState; the rest is cast away (mirrors result-to-facts.route.test).
function mkState(currentNode: string): RunState {
  return {
    runId: "r",
    version: 1,
    status: "running",
    currentNode,
    workflowSha: "g",
    schemaVersion: 1,
    routing: {},
    metrics: { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, nodeCosts: {} },
  } as unknown as RunState;
}

const arbAccounting = fc.record({
  turnBilled: fc.nat({ max: 100_000 }),
  totalCostUsd: fc.double({ min: 0, max: 100, noNaN: true }),
  totalInputTokens: fc.nat({ max: 100_000 }),
  totalOutputTokens: fc.nat({ max: 100_000 }),
  totalCacheReadTokens: fc.nat({ max: 100_000 }),
  totalCacheWriteTokens: fc.nat({ max: 100_000 }),
  lastModel: fc.option(fc.constantFrom("claude-opus-4-7", "gpt-5"), { nil: undefined }),
});

// nextNode is left unset so edge selection fires against the generated graph
// (Phase 1 graphs declare no routes, so `route` stays unset too).
const arbTransition = fc.record({
  kind: fc.constant<"transition">("transition"),
  outcomeStatus: fc.constantFrom<"success" | "fail" | "retry">("success", "fail", "retry"),
  tokens: fc.nat({ max: 100_000 }),
  costUsd: fc.double({ min: 0, max: 100, noNaN: true }),
});

const arbYieldHuman = fc.record({
  kind: fc.constant<"yield_human">("yield_human"),
  text: fc.string(),
  routes: fc.array(fc.constantFrom("approve", "reject", "revise"), { minLength: 1, maxLength: 3 }),
});

const arbHalt = fc.record({
  kind: fc.constant<"halt">("halt"),
  reason: fc.constantFrom<"budget" | "max_loops" | "error" | "goal_gate_unsatisfied" | "max_retries_exceeded">(
    "budget",
    "max_loops",
    "error",
    "goal_gate_unsatisfied",
    "max_retries_exceeded",
  ),
  detail: fc.option(fc.string(), { nil: undefined }),
});

const arbPauseProvider = fc.record({
  kind: fc.constant<"pause_provider">("pause_provider"),
  httpStatus: fc.constantFrom<number | null>(402, 429, 500, 503, null),
  provider: fc.constantFrom("anthropic", "openai"),
  errorMessage: fc.string(),
  retryAfterMs: fc.option(fc.nat({ max: 60_000 }), { nil: undefined }),
});

const arbHandlerResult = fc.oneof(
  arbTransition,
  arbYieldHuman,
  arbHalt,
  arbPauseProvider,
) as fc.Arbitrary<HandlerResult>;

const arbDecision = fc
  .record({
    routingDelta: fc.dictionary(fc.constantFrom("k1", "k2", "internal.x"), fc.oneof(fc.nat(), fc.string()), {
      maxKeys: 3,
    }),
    shouldPauseAfterDispatch: fc.boolean(),
    appliedSeqs: fc.array(fc.nat({ max: 1000 }), { maxLength: 5 }),
  })
  .map((d) => ({
    kind: "proceed" as const,
    routingDelta: d.routingDelta,
    shouldPause: false,
    shouldPauseAfterDispatch: d.shouldPauseAfterDispatch,
    appliedSeqs: d.appliedSeqs,
    dropped: [],
  })) as fc.Arbitrary<TransitionInput["decision"]>;

/** Compose a full TransitionInput from a (parameterizable) handler-result
 * arbitrary, so HITL-only properties can narrow to yield_human. */
function inputArb(resultArb: fc.Arbitrary<HandlerResult>): fc.Arbitrary<TransitionInput> {
  return fc
    .tuple(arbGraphWithCurrentNode, resultArb, arbDecision, arbAccounting, fc.nat({ max: 1e9 }), fc.nat({ max: 10 }))
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

const arbInput = inputArb(arbHandlerResult);

const factTypes = (plan: { facts: { type: string }[] }): Set<string> => new Set(plan.facts.map((f) => f.type));

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
      { numRuns: 1000 },
    );
  });

  test("B: at most one terminal fact (run_completed | run_halted)", () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const plan = planTransition(input);
        const terminals = plan.facts.filter((f) => f.type === "fact.run_completed" || f.type === "fact.run_halted");
        expect(terminals.length).toBeLessThanOrEqual(1);
      }),
      { numRuns: 1000 },
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
      { numRuns: 1000 },
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
      { numRuns: 1000 },
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
      { numRuns: 1000 },
    );
  });

  test("F: yield_human ⇒ run_paused_human, no node_started, no terminal (the HITL pause)", () => {
    fc.assert(
      fc.property(inputArb(arbYieldHuman), (input) => {
        const t = factTypes(planTransition(input));
        expect(t.has("fact.run_paused_human")).toBe(true);
        expect(t.has("fact.node_started")).toBe(false);
        expect(t.has("fact.run_completed")).toBe(false);
        expect(t.has("fact.run_halted")).toBe(false);
      }),
      { numRuns: 500 },
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
      { numRuns: 500 },
    );
  });
});
