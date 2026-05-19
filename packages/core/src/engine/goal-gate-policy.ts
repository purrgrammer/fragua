// Goal-gate policy reducer — attractor-spec §3.4.
//
// When traversal reaches a terminal (Msquare), every node visited with
// `goal_gate=true` must have settled in SUCCESS or PARTIAL_SUCCESS for the
// run to exit cleanly. If any gate is unsatisfied, route to its retarget:
//
//   1. failed gate's `retry_target`
//   2. failed gate's `fallback_retry_target`
//   3. graph's `retry_target`
//   4. graph's `fallback_retry_target`
//
// If no target resolves, the run halts with `goal_gate_unsatisfied`.
//
// Swarm caps the retarget loop with `max_goal_gate_retries` (graph attr,
// default 3) so a misconfigured retry target can't burn the run forever.
// Attractor §3.4 step 4 is unbounded; this is a swarm-local safety guard
// (see docs/SPEC.md §6.4).
//
// This module is the pure reducer the executor consults. Property tests
// exercise the chain without spinning the executor.

import type { Graph, NodeAttrs } from "../types/graph.ts";
import type { OutcomeStatus } from "../types/outcome.ts";

/** Default retarget cap when graph.attrs.max_goal_gate_retries is unset. */
export const DEFAULT_MAX_GOAL_GATE_RETRIES = 3;

/** Routing-key prefix for per-gate outcome records. Folded across the run
 * by appending `goal_gates.<nodeId>: <outcomeStatus>` to the routing patch
 * whenever a goal_gate=true node completes. */
export const GOAL_GATE_OUTCOME_KEY_PREFIX = "goal_gates.";

/** Routing key holding the cumulative count of goal-gate retargets in the
 * current run. Bumped each time `goalGateStep` returns a `retarget` action. */
export const GOAL_GATE_RETRIES_KEY = "goal_gates.__retries";

/** Build the routing key for a given gate node id. */
export function goalGateOutcomeKey(nodeId: string): string {
  return `${GOAL_GATE_OUTCOME_KEY_PREFIX}${nodeId}`;
}

/** Read the cumulative retarget count from a routing snapshot. Defaults to 0
 * for a never-retargeted run. */
export function readGoalGateRetries(routing: Record<string, unknown>): number {
  const v = routing[GOAL_GATE_RETRIES_KEY];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Read all per-gate outcomes from a routing snapshot. Keys outside the
 * `goal_gates.*` namespace (or the reserved `__retries` slot) are ignored. */
export function readGateOutcomes(routing: Record<string, unknown>): GateOutcomes {
  const out = new Map<string, OutcomeStatus>();
  for (const [k, v] of Object.entries(routing)) {
    if (!k.startsWith(GOAL_GATE_OUTCOME_KEY_PREFIX)) continue;
    if (k === GOAL_GATE_RETRIES_KEY) continue;
    if (typeof v !== "string") continue;
    if (v === "success" || v === "fail" || v === "retry") {
      out.set(k.slice(GOAL_GATE_OUTCOME_KEY_PREFIX.length), v);
    }
  }
  return out;
}

/** Per-gate outcome captured as the run executes. */
export type GateOutcomes = ReadonlyMap<string, OutcomeStatus>;

export type GateCheck = { satisfied: true } | { satisfied: false; failedGate: string };

/** Inspect every gate node. First unsatisfied (visit order) is reported.
 * A gate is satisfied iff it is in `outcomes` AND its status is SUCCESS or
 * PARTIAL_SUCCESS. Unvisited gates are vacuously satisfied — the run
 * never reached them, so the contract was never made.
 *
 * Visit order matters: when a graph has multiple unsatisfied gates, the
 * first one in graph.nodes iteration order wins, so the retarget chain
 * walks deterministically.
 */
export function checkGoalGates(graph: Graph, outcomes: GateOutcomes): GateCheck {
  for (const node of Object.values(graph.nodes)) {
    if (node.attrs.goal_gate !== true) continue;
    const status = outcomes.get(node.id);
    if (status === undefined) continue; // never executed → vacuously ok
    if (status === "success") continue;
    return { satisfied: false, failedGate: node.id };
  }
  return { satisfied: true };
}

/** Resolve the §3.4 retarget. Returns the gate's `retry_target` when it
 * resolves to an existing node, else null (run halts). */
export function resolveRetargetChain(graph: Graph, failedGateId: string): string | null {
  const gate = graph.nodes[failedGateId];
  const id = gate?.attrs.retry_target;
  if (typeof id === "string" && id !== "" && graph.nodes[id] != null) return id;
  return null;
}

/** Resolve the §3.7 failure-routing retarget for a single node. The
 * fail-edge case lives in edge-selection; pipeline termination is the
 * absence of any retarget here. */
export function resolveFailRetarget(graph: Graph, sourceNodeId: string): string | null {
  const node = graph.nodes[sourceNodeId];
  const id = node?.attrs.retry_target;
  if (typeof id === "string" && id !== "" && graph.nodes[id] != null) return id;
  return null;
}

/** Effective `max_goal_gate_retries` for a graph. Falls back to
 * `DEFAULT_MAX_GOAL_GATE_RETRIES` when unset. Negative or non-finite
 * values clamp to 0 (no retries permitted). */
export function maxGoalGateRetries(attrs: NodeAttrs | { max_goal_gate_retries?: number }): number {
  const raw = (attrs as { max_goal_gate_retries?: number }).max_goal_gate_retries;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MAX_GOAL_GATE_RETRIES;
  return Math.max(0, Math.floor(raw));
}

export type GoalGateAction =
  /** All gates satisfied — let the terminal exit emit `fact.run_completed`. */
  | { kind: "exit" }
  /** A gate is unsatisfied; redirect to this node id and bump the counter. */
  | { kind: "retarget"; gate: string; target: string; nextRetries: number }
  /** Retarget exhausted — halt the run with `goal_gate_unsatisfied`. */
  | { kind: "halt"; reason: "goal_gate_unsatisfied"; gate: string };

export interface GoalGateInput {
  graph: Graph;
  outcomes: GateOutcomes;
  /** Cumulative retarget count for this run; starts at 0. Bumped each
   * time the executor jumps back via this reducer. */
  retries: number;
  /** Operator override for the per-run retarget cap, threaded by the
   * executor from `routing.max_goal_gate_retries_override` (set via
   * `intent.goal_gate_adjusted`). Takes precedence over the static
   * `graph.attrs.max_goal_gate_retries`. Stage 3 of
   * docs/proposals/recoverable-budget-pause.md. */
  capOverride?: number;
}

/** Decide what to do when traversal reaches a terminal. Pure. */
export function goalGateStep(input: GoalGateInput): GoalGateAction {
  const check = checkGoalGates(input.graph, input.outcomes);
  if (check.satisfied) return { kind: "exit" };

  const cap = input.capOverride && input.capOverride > 0 ? input.capOverride : maxGoalGateRetries(input.graph.attrs);
  if (input.retries >= cap) {
    return { kind: "halt", reason: "goal_gate_unsatisfied", gate: check.failedGate };
  }

  const target = resolveRetargetChain(input.graph, check.failedGate);
  if (target == null) {
    return { kind: "halt", reason: "goal_gate_unsatisfied", gate: check.failedGate };
  }

  return { kind: "retarget", gate: check.failedGate, target, nextRetries: input.retries + 1 };
}
