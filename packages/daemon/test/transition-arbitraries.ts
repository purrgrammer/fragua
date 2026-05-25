// fast-check arbitraries for the `planTransition` inputs that are NOT the
// graph or run-state — i.e. the *transition types*: the handler's return
// (`HandlerResult`), this turn's accounting, and the proceed-fold decision.
// The graph + state arbitraries compose with these (they bind node ids; pass
// the same pool here via `nodeIds` so generated `nextNode`s line up).
//
// exactOptionalPropertyTypes is on, so optional fields must be ABSENT, never
// `{ key: undefined }`. `dropUndefined` prunes generated `undefined`s so the
// objects are structurally-valid union members.

import type { HandlerResult, IntentDecision } from "@fragua/core/handler";
import fc from "fast-check";
import type { TurnAccounting } from "../src/transition-planner.ts";

export type ProceedDecision = Extract<IntentDecision, { kind: "proceed" }>;

/** Default node-id pool. Includes the three terminal aliases the planner
 * special-cases (`__end__` / `end` / `done`) plus a handful of step names so
 * a generated `nextNode` either lands on a real node, a terminal, or an
 * unknown id (each exercises a different branch). Override to align with a
 * graph arbitrary. */
export const DEFAULT_NODE_IDS = ["plan", "implement", "review", "gate", "__end__", "end", "done", "exit"] as const;

/** Default route-name pool — the labels a routing node's `routes=` declares. */
export const DEFAULT_ROUTES = ["feature", "bugfix", "approve", "reject", "skip"] as const;

const MODELS = ["claude-opus-4-7", "claude-sonnet-4-6", "gpt-4o", "gemini-2.5-pro"] as const;

/** Non-negative token counts; biased small but reaches large to breach
 * token budgets. */
const tokens = fc.nat({ max: 2_000_000 });
/** Non-negative, finite USD; max 50 so a generated turn cost readily breaches
 * the small per-run/per-node ceilings a budget graph declares. */
const usd = fc.double({ min: 0, max: 50, noNaN: true });

/** Drop keys whose value is `undefined` so the result satisfies
 * exactOptionalPropertyTypes (an absent optional, not an explicit undefined). */
function dropUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

const someStr = fc.string({ minLength: 1, maxLength: 24 });

/** `kind: "transition"` — the rich, most-exercised arm. Spans the whole
 * field surface: explicit vs absent `nextNode` (verbatim-route vs
 * edge-selection), every `outcomeStatus`, optional `route` (drives route-case
 * selection / `edge_no_match`), `failureReason`, the lump `tokens`/`costUsd`
 * (always present) and every optional cost/token split + `modelName`. */
function arbTransition(nodeIds: readonly string[], routes: readonly string[]): fc.Arbitrary<HandlerResult> {
  return fc
    .record({
      nextNode: fc.option(fc.constantFrom(...nodeIds), { nil: undefined }),
      outcomeStatus: fc.option(
        fc.constantFrom("success", "fail", "retry") as fc.Arbitrary<"success" | "fail" | "retry">,
        {
          nil: undefined,
        },
      ),
      route: fc.option(fc.constantFrom(...routes), { nil: undefined }),
      failureReason: fc.option(someStr, { nil: undefined }),
      tokens,
      costUsd: usd,
      inputCostUsd: fc.option(usd, { nil: undefined }),
      outputCostUsd: fc.option(usd, { nil: undefined }),
      cacheReadCostUsd: fc.option(usd, { nil: undefined }),
      cacheWriteCostUsd: fc.option(usd, { nil: undefined }),
      inputTokens: fc.option(tokens, { nil: undefined }),
      outputTokens: fc.option(tokens, { nil: undefined }),
      cacheReadTokens: fc.option(tokens, { nil: undefined }),
      cacheWriteTokens: fc.option(tokens, { nil: undefined }),
      modelName: fc.option(fc.constantFrom(...MODELS), { nil: undefined }),
    })
    .map((r) => dropUndefined({ kind: "transition" as const, ...r })) as fc.Arbitrary<HandlerResult>;
}

/** `kind: "yield_human"` — a human-node yield. Flows straight to
 * `resultToFacts` (→ `fact.run_paused_human`); the planner's transition-only
 * rewrites skip it, so it's the control case for "non-transition is passed
 * through untouched." Exported so a HITL-pause property can narrow to it. */
export function arbYieldHuman(routes: readonly string[]): fc.Arbitrary<HandlerResult> {
  return fc
    .record({
      text: someStr,
      routes: fc.uniqueArray(fc.constantFrom(...routes), { minLength: 1, maxLength: routes.length }),
      routeLabels: fc.option(fc.dictionary(fc.constantFrom(...routes), someStr), { nil: undefined }),
    })
    .map((r) => dropUndefined({ kind: "yield_human" as const, ...r })) as fc.Arbitrary<HandlerResult>;
}

/** `kind: "halt"` — every handler-constructible `HaltReason` (incl. the ones
 * `resultToFacts` translates into recoverable pauses), with optional `detail`
 * + `pauseContext`. */
function arbHalt(): fc.Arbitrary<HandlerResult> {
  const reason = fc.constantFrom(
    "budget",
    "max_loops",
    "error",
    "goal_gate_unsatisfied",
    "max_retries_exceeded",
    "route_not_picked",
    "route_call_not_isolated",
    "edge_no_match",
  ) as fc.Arbitrary<Extract<HandlerResult, { kind: "halt" }>["reason"]>;
  return fc
    .record({
      reason,
      detail: fc.option(someStr, { nil: undefined }),
      pauseContext: fc.option(
        fc
          .record({
            currentLimit: fc.option(fc.nat({ max: 20 }), { nil: undefined }),
            attempts: fc.option(fc.nat({ max: 20 }), { nil: undefined }),
          })
          .map(dropUndefined),
        { nil: undefined },
      ),
    })
    .map((r) => dropUndefined({ kind: "halt" as const, ...r })) as fc.Arbitrary<HandlerResult>;
}

/** `kind: "pause_provider"` — the recoverable provider-transport arm. The
 * `httpStatus` pool spans the policy branches `decideProviderRetry` keys on:
 * 402 → payment_required, 429/5xx → auto-retry-eligible, 4xx → manual, and
 * `null` → manual. Required fields stay present (only `retryAfterMs` is
 * optional). */
function arbPauseProvider(): fc.Arbitrary<HandlerResult> {
  return fc
    .record({
      httpStatus: fc.option(fc.constantFrom(400, 401, 402, 408, 429, 500, 502, 503, 529), { nil: null }),
      provider: fc.constantFrom("anthropic", "openai", "google", "custom"),
      errorMessage: someStr,
      retryAfterMs: fc.option(fc.nat({ max: 60_000 }), { nil: undefined }),
    })
    .map((r) => dropUndefined({ kind: "pause_provider" as const, ...r })) as fc.Arbitrary<HandlerResult>;
}

export interface HandlerResultArbOpts {
  /** Candidate `nextNode` ids. Pass the graph arbitrary's node pool so
   * generated transitions land on real nodes / terminals / unknowns. */
  nodeIds?: readonly string[];
  /** Candidate route names (a routing node's `routes=`). */
  routes?: readonly string[];
}

/** The full `HandlerResult` union, weighted toward `transition` (the arm the
 * planner does the most work for). The other three arms cover pass-through
 * (`yield_human`), direct halts, and the provider-retry rewrite path. */
export function arbHandlerResult(opts: HandlerResultArbOpts = {}): fc.Arbitrary<HandlerResult> {
  const nodeIds = opts.nodeIds ?? DEFAULT_NODE_IDS;
  const routes = opts.routes ?? DEFAULT_ROUTES;
  return fc.oneof(
    { weight: 6, arbitrary: arbTransition(nodeIds, routes) },
    { weight: 1, arbitrary: arbYieldHuman(routes) },
    { weight: 2, arbitrary: arbHalt() },
    { weight: 2, arbitrary: arbPauseProvider() },
  );
}

/** This turn's accumulated LLM accounting. `lastModel` is a required key whose
 * value may be `undefined` (not an optional key), so it is not pruned. */
export const arbAccounting: fc.Arbitrary<TurnAccounting> = fc.record({
  turnBilled: tokens,
  totalCostUsd: usd,
  totalInputTokens: tokens,
  totalOutputTokens: tokens,
  totalCacheReadTokens: tokens,
  totalCacheWriteTokens: tokens,
  lastModel: fc.option(fc.constantFrom(...MODELS), { nil: undefined }),
});

/** Arbitrary routing-delta value — routing is `Record<string, unknown>`. */
const routingValue = fc.oneof(someStr, fc.integer({ min: 0, max: 100 }), fc.boolean());

/** The proceed-variant intent fold the planner consumes. `shouldPause` is
 * always false (immediate-pause returns before dispatch, so the planner never
 * sees it); `shouldPauseAfterDispatch` (R3) is generated to exercise the
 * pause-defer swap. `steering` / `humanInput` are pre-dispatch concerns the
 * planner ignores, so they're omitted. */
export const arbProceedDecision: fc.Arbitrary<ProceedDecision> = fc
  .record({
    routingDelta: fc.dictionary(someStr, routingValue, { maxKeys: 4 }),
    shouldPauseAfterDispatch: fc.boolean(),
    appliedSeqs: fc.uniqueArray(fc.nat({ max: 100_000 }), { maxLength: 6 }),
  })
  .map(
    (r) =>
      ({
        kind: "proceed",
        routingDelta: r.routingDelta,
        shouldPause: false,
        shouldPauseAfterDispatch: r.shouldPauseAfterDispatch,
        appliedSeqs: r.appliedSeqs,
        dropped: [],
      }) satisfies ProceedDecision,
  );
