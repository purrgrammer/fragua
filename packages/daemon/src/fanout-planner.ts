// The PURE fan-out frontier decision — the seed-vs-join-vs-dispatch choice for
// a `type: parallel` node, lifted out of `runFanout`'s IO loop so it can be
// reasoned about (and tested) without a store, clock, or randomness.
//
// `runFanout` reads the frontier (active set from routing, the aborted subset
// from the lifecycle log), calls `planFanoutStep`, then APPLIES the returned
// plan against the store. The closure scope a parallel node's budget cap sums
// over still comes from the shared `fanoutClosureUnion` walk in
// `@fragua/core`; this planner reasons only about the frontier transition.
//
// The run-level DISPOSITION decisions a fan-out superstep makes as branches
// settle — the halt-over-pause precedence, the fail-closed branch-terminal halt,
// and the per-branch abort-loop pause — are lifted here too (pure fact choices,
// no store / clock / RNG), so the driver only applies them.

import type { FactEvent } from "@fragua/store";

/** The frontier of one `type: parallel` node at the start of a fan-out turn,
 * as plain data. `active`/`redispatch` are already folded by the caller — the
 * planner performs no IO of its own. */
export interface FanoutFrontier {
  /** The active branch set folded from routing (`readActiveNodes`). `null`
   *  means the frontier has not been seeded yet; an empty array means every
   *  branch has drained into the join. */
  readonly active: readonly string[] | null;
  /** The subset of `active` whose latest lifecycle fact is `node_aborted`
   *  (`abortedActiveBranches`) — they need a fresh `dispatch_started` to
   *  project as running again. Empty unless the frontier is live. */
  readonly redispatch: readonly string[];
  /** The parallel node's declared branch entries (`attrs.branches`). */
  readonly branches: readonly string[];
  /** The parallel node's join target (`attrs.join`); `undefined` is malformed. */
  readonly join: string | undefined;
}

/** The next action `runFanout` should apply against the store. */
export type FanoutPlan =
  /** No join, or no branches — structurally malformed; caller terminates the
   *  run with `fanout_malformed`. */
  | { readonly kind: "malformed" }
  /** Fresh frontier — caller seeds with `fanout_started` over `branches`. */
  | { readonly kind: "seed"; readonly branches: readonly string[] }
  /** Frontier drained — caller advances `current_node` to the join via
   *  `fanout_joined`. */
  | { readonly kind: "join"; readonly nextNode: string; readonly branchesCompleted: number }
  /** Live frontier — caller dispatches `active` into the reactive pool, first
   *  re-marking each branch in `redispatch` with `dispatch_started`. The
   *  parallel node stays `current_node` (the run "parks" here while branches
   *  run); `redispatch` is empty on a healthy frontier. */
  | { readonly kind: "dispatch"; readonly active: readonly string[]; readonly redispatch: readonly string[] };

/** Classify a fan-out frontier into the next transition. Pure: same frontier
 * in ⇒ same plan out, no store / clock / randomness. The ordering mirrors
 * `runFanout`'s original control flow — malformed first, then seed (unseeded),
 * then join (drained), then dispatch the live frontier. */
export function planFanoutStep(frontier: FanoutFrontier): FanoutPlan {
  const { active, redispatch, branches, join } = frontier;
  if (join === undefined || branches.length === 0) return { kind: "malformed" };
  if (active === null) return { kind: "seed", branches };
  if (active.length === 0) return { kind: "join", nextNode: join, branchesCompleted: branches.length };
  return { kind: "dispatch", active, redispatch };
}

/** Fold one settling branch's run-level fact into the pool's single disposition
 * slot with the precedence rule: a halt (`run_terminated`) always overrides a
 * pause (terminal beats resumable), first-of-each-kind wins, and a pause never
 * downgrades a captured halt. Returns the (possibly unchanged) disposition. */
export function noteDisposition(current: FactEvent | undefined, incoming: FactEvent): FactEvent | undefined {
  if (incoming.type === "fact.run_terminated") {
    return current?.type === "fact.run_terminated" ? current : incoming;
  }
  return current ?? incoming;
}

/** The fail-closed halt for a branch that resolved to a run terminal (`next:
 * exit`, a fail-only edge succeeding into `__end__`, or a sentinel/dangling
 * successor). Completing the run mid-fan-out would strand the in-flight siblings
 * — the validator rejects the shape (E032/E039/E041), so this is the runtime
 * backstop for an unvalidated save. */
export function planBranchTerminal(nodeId: string): FactEvent {
  return {
    type: "fact.run_terminated",
    payload: { status: "errored", reason: "error", detail: `fanout_branch_terminal:${nodeId}` },
  };
}

/** The per-branch abort-loop pause: a branch that aborted `ceiling` turns in a
 * row parks the run regardless of sibling success. Returns the first such
 * branch's pause fact, or undefined when every streak is below the ceiling. */
export function planBranchAbortLoop(branchAborts: ReadonlyMap<string, number>, ceiling: number): FactEvent | undefined {
  for (const [nodeId, streak] of branchAborts) {
    if (streak >= ceiling) {
      return { type: "fact.run_paused", payload: { reason: "abort_loop", nodeId, consecutiveAborts: streak } };
    }
  }
  return undefined;
}
