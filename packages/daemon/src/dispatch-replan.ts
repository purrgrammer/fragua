// Re-planning for the linear dispatch's commit arms, split out of
// `dispatch-turn.ts`: the effective-routing build, the pure transition / exit
// plans bound to a version, and the re-fold that lets a version-only OCC
// conflict re-plan the SAME handler result against fresh state instead of
// re-dispatching the handler. This file does store I/O (on IO_ALLOWED).
//
// ARCHITECTURE.md §6.1.

import { readPauseAfterDispatch } from "@fragua/core";
import * as core from "@fragua/core/handler";
import { materializeRouting, type RunState } from "@fragua/store";
import { type BudgetBreach, type ExitKind, planExit } from "./abort-planner.ts";
import { graphFor, type ObservabilitySink, type RunDeps, type UsageAccumulator } from "./dispatch-wiring.ts";
import { type OccReplan, occAppendOnce } from "./occ-append.ts";
import type { RunTurnState } from "./run-turn-state.ts";
import { planTransition } from "./transition-planner.ts";

type ProceedDecision = Extract<core.IntentDecision, { kind: "proceed" }>;

export function emitDropped(deps: RunDeps, dropped: core.IntentDecision["dropped"]): void {
  if (dropped.length === 0) return;
  deps.opts.store.appendObservabilityEvents(
    deps.runId,
    dropped.map((d) => ({
      type: "intent.dropped",
      payload: { originalSeq: d.seq, originalType: d.type, reason: d.reason },
    })),
  );
}

/** Effective routing for this turn: the projection view merged with the fold's
 * routing delta, with any `$fragua_blob` inputs materialized. */
export function buildEffectiveRouting(
  deps: RunDeps,
  runState: RunState,
  decision: ProceedDecision,
): Readonly<Record<string, unknown>> {
  const rawEffectiveRouting: Readonly<Record<string, unknown>> =
    Object.keys(decision.routingDelta).length > 0
      ? { ...runState.routing, ...decision.routingDelta }
      : runState.routing;
  return materializeRouting(rawEffectiveRouting as Record<string, unknown>, (sha) => {
    const bytes = deps.opts.store.readBlob(sha);
    if (bytes == null) throw new Error(`routing blob missing: ${sha}`);
    return bytes;
  });
}

export interface ExitArgs {
  exit: ExitKind;
  currentNode: string;
  iteration: number;
  errorDetail?: string;
  reactiveBudgetHaltDetail: string | undefined;
  reactiveBudgetPauseBreach: BudgetBreach | undefined;
  usage: UsageAccumulator;
  effectiveRouting: Readonly<Record<string, unknown>>;
  spec: core.HandlerSpec;
  recorder: { version: () => number };
}

export interface TransitionArgs {
  currentNode: string;
  iteration: number;
  result: core.HandlerResult;
  usage: UsageAccumulator;
  effectiveRouting: Readonly<Record<string, unknown>>;
  deferredPause: boolean;
  obs: ObservabilitySink;
  recorder: { version: () => number };
}

export type AppendOpts = { routingPatch?: Record<string, unknown>; advanceAppliedTo?: number };

/** The pure exit plan over `routing`, with its append options and a commit
 * bound to `version` — re-run against fresh routing on a version conflict. */
export function planExitCommit(
  deps: RunDeps,
  decision: ProceedDecision,
  a: ExitArgs,
  routing: Readonly<Record<string, unknown>>,
  version: number,
): { plan: ReturnType<typeof planExit>; appendOpts: AppendOpts; commit: OccReplan["commit"] } {
  const plan = planExit({
    exit: a.exit,
    currentNode: a.currentNode,
    iteration: a.iteration,
    ...(a.errorDetail !== undefined ? { errorDetail: a.errorDetail } : {}),
    leakedAt: deps.clock(),
    reactiveBudgetHaltDetail: a.reactiveBudgetHaltDetail,
    reactiveBudgetPauseBreach: a.reactiveBudgetPauseBreach,
    usage: a.usage.totals(),
    routingDelta: decision.routingDelta,
    appliedSeqs: decision.appliedSeqs,
    effectiveRouting: routing,
    now: deps.clock(),
    attemptedMs: a.spec.maxMs ?? 0,
  });
  const appendOpts: AppendOpts = {};
  if (plan.routingPatch !== undefined) appendOpts.routingPatch = plan.routingPatch;
  if (plan.advanceAppliedTo !== undefined) appendOpts.advanceAppliedTo = plan.advanceAppliedTo;
  return { plan, appendOpts, commit: occAppendOnce(deps.opts.store, deps.runId, version, appendOpts) };
}

export function planTransitionCommit(
  deps: RunDeps,
  ts: RunTurnState,
  state: RunState,
  decision: ProceedDecision,
  a: TransitionArgs,
  effectiveRouting: Readonly<Record<string, unknown>>,
  version: number,
): OccReplan & { observability: ReturnType<typeof planTransition>["observability"] } {
  const deferredPause = a.deferredPause || readPauseAfterDispatch(effectiveRouting);
  const planDecision =
    deferredPause && !decision.shouldPauseAfterDispatch ? { ...decision, shouldPauseAfterDispatch: true } : decision;
  const plan = planTransition({
    state,
    decision: planDecision,
    graph: graphFor(deps, ts, state.workflowSha),
    handlerResult: a.result,
    accounting: a.usage.totals(),
    effectiveRouting,
    currentNode: a.currentNode,
    iteration: a.iteration,
    now: deps.clock(),
    random: deps.random,
    providerRetryAfterMaxMs: deps.providerRetryAfterMaxMs,
  });
  const appendOpts: AppendOpts = {};
  if (plan.routingPatch !== undefined) appendOpts.routingPatch = plan.routingPatch;
  if (plan.advanceAppliedTo !== undefined) appendOpts.advanceAppliedTo = plan.advanceAppliedTo;
  return {
    facts: plan.facts,
    expectedVersion: version,
    commit: occAppendOnce(deps.opts.store, deps.runId, version, appendOpts),
    observability: plan.observability,
  };
}

export function replanTransition(
  deps: RunDeps,
  ts: RunTurnState,
  fresh: RunState,
  decision: ProceedDecision,
  a: TransitionArgs,
): OccReplan | undefined {
  if (fresh.currentNode !== a.currentNode) return undefined;
  const d = refoldForReplan(deps, fresh, decision);
  const { facts, expectedVersion, commit } = planTransitionCommit(
    deps,
    ts,
    fresh,
    d,
    a,
    buildEffectiveRouting(deps, fresh, d),
    fresh.version,
  );
  return { facts, expectedVersion, commit };
}

/** Re-fold the unapplied intents for a re-plan. Only a plain fold-only batch
 * (no cancel / pause / new steer / new human input) replaces the turn's
 * decision; anything that must reach a dispatch stays unapplied for the next
 * turn's gates. Newly dropped intents are audited once. */
function refoldForReplan(deps: RunDeps, fresh: RunState, decision: ProceedDecision): ProceedDecision {
  const refold = core.foldIntents(deps.opts.store.getUnappliedIntents(deps.runId), fresh.status);
  const seen = new Set(decision.dropped.map((d) => d.seq));
  emitDropped(
    deps,
    refold.dropped.filter((d) => !seen.has(d.seq)),
  );
  if (refold.kind !== "proceed" || refold.shouldPause) return decision;
  if (refold.steering !== decision.steering) return decision;
  if (JSON.stringify(refold.humanInput) !== JSON.stringify(decision.humanInput)) return decision;
  return refold;
}
