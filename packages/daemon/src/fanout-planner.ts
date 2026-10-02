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

import type { BudgetDecision } from "@fragua/core";
import type { FactEvent } from "@fragua/store";
import { nodeRetryCount, passField } from "./executor-helpers.ts";

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

/** The structural halt for a `type: parallel` node that declares no join or no
 * branches (`planFanoutStep` → `malformed`). The validator rejects the shape at
 * save; this is the runtime backstop for an unvalidated save. */
export function planFanoutMalformed(): FactEvent {
  return {
    type: "fact.run_terminated",
    payload: { status: "errored", reason: "error", detail: "fanout_malformed" },
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

/** Map a run-level budget evaluation into the parallel node's disposition fact:
 * a `stop`-policy breach halts (`run_terminated{budget}`), a `pause`-policy
 * breach parks (`run_paused{budget}`), no breach is undefined. The caller keeps
 * the store reads + `evaluateBudget` call (I/O); this is only the fact choice,
 * symmetric with the linear path's `planAbort` budget arms. */
export function planBudgetDisposition(budget: BudgetDecision, nodeId: string): FactEvent | undefined {
  if (budget.shouldHalt) {
    const payload: { status: "errored"; reason: "budget"; detail?: string } = { status: "errored", reason: "budget" };
    if (budget.haltReason !== undefined && budget.haltReason.length > 0) payload.detail = budget.haltReason;
    return { type: "fact.run_terminated", payload };
  }
  if (budget.pauseBreach !== undefined) {
    const b = budget.pauseBreach;
    return {
      type: "fact.run_paused",
      payload: { reason: "budget", nodeId, scope: b.scope, metric: b.metric, limit: b.limit, actual: b.actual },
    };
  }
  return undefined;
}

/** The single `fact.fanout_started` that seeds a fresh frontier over the
 * declared branch entries. */
export function planSeedFanout(args: {
  nodeId: string;
  iteration: number;
  pass: number;
  branches: readonly string[];
}): FactEvent[] {
  return [
    {
      type: "fact.fanout_started",
      payload: {
        nodeId: args.nodeId,
        iteration: args.iteration,
        ...passField(args.pass),
        branches: [...args.branches],
      },
    },
  ];
}

/** The join transition: a deferred operator pause parks the run
 * (`run_paused{operator}`), otherwise the region closes with `fanout_joined`. */
export function planJoin(args: {
  deferredPause: boolean;
  nodeId: string;
  iteration: number;
  pass: number;
  nextNode: string;
  branchesCompleted: number;
}): FactEvent {
  if (args.deferredPause) return { type: "fact.run_paused", payload: { reason: "operator", nodeId: args.nodeId } };
  return {
    type: "fact.fanout_joined",
    payload: {
      nodeId: args.nodeId,
      iteration: args.iteration,
      ...passField(args.pass),
      nextNode: args.nextNode,
      branchesCompleted: args.branchesCompleted,
    },
  };
}

/** The result of folding one settled branch's completion facts. */
export interface BranchSettlement {
  /** Node-scoped facts to commit for this branch (its `node_completed` plus a
   *  bundled successor `dispatch_started` when the branch continues). */
  readonly branchFacts: FactEvent[];
  /** The (possibly updated) pool disposition slot after folding this branch's
   *  run-level facts + the fail-closed branch-terminal halt. */
  readonly disposition: FactEvent | undefined;
  /** The successor to dispatch next, or undefined (branch drained into the join,
   *  or resolved to a terminal). */
  readonly successor: string | undefined;
  /** Whether this branch resolved to a run terminal (fail-closed halt captured
   *  into `disposition`). */
  readonly terminal: boolean;
}

/** Fold one successful branch's completion facts into its node-scoped commit
 * batch, the pool disposition, and the successor to dispatch. Pure: the caller
 * keeps the store commit (I/O); this is the fact-selection the driver used to
 * inline. Sorts run-level facts to the disposition (halt-over-pause via
 * `noteDisposition`), keeps the rest as branch facts, fails closed on a
 * successor that resolves to a run terminal or is missing from the graph, and
 * bundles the successor's `dispatch_started`. */
export function planBranchSettlement(args: {
  nodeId: string;
  facts: readonly FactEvent[];
  nextNode: string | undefined;
  join: string | undefined;
  graphNodes: Readonly<Record<string, unknown>> | null;
  pass: number;
  liveRouting: Record<string, unknown>;
  routingPatch: Record<string, unknown> | undefined;
  disposition: FactEvent | undefined;
}): BranchSettlement {
  const branchFacts: FactEvent[] = [];
  let disposition = args.disposition;
  let terminal = false;
  for (const f of args.facts) {
    if (f.type === "fact.run_terminated" && f.payload.status === "completed") {
      terminal = true;
    } else if (f.type === "fact.run_terminated" || f.type === "fact.run_paused") {
      disposition = noteDisposition(disposition, f);
    } else if (f.type !== "fact.node_started") {
      branchFacts.push(f);
    }
  }
  let successor = args.nextNode !== undefined && args.nextNode !== args.join ? args.nextNode : undefined;
  if (successor !== undefined && (args.graphNodes === null || args.graphNodes[successor] === undefined)) {
    terminal = true;
    successor = undefined;
  }
  if (terminal) {
    successor = undefined;
    disposition = noteDisposition(disposition, planBranchTerminal(args.nodeId));
  }
  if (successor !== undefined) {
    const successorRouting =
      args.routingPatch !== undefined ? { ...args.liveRouting, ...args.routingPatch } : args.liveRouting;
    branchFacts.push({
      type: "fact.dispatch_started",
      payload: {
        nodeId: successor,
        iteration: nodeRetryCount(successorRouting, successor),
        ...passField(args.pass),
        resumeOf: "fresh",
      },
    });
  }
  return { branchFacts, disposition, successor, terminal };
}
