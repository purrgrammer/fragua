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

/** Per-gate outcome captured as the run executes. */
export type GateOutcomes = ReadonlyMap<string, OutcomeStatus>;

export type GateCheck =
  | { satisfied: true }
  | { satisfied: false; failedGate: string };

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
    if (status === "success" || status === "partial_success") continue;
    return { satisfied: false, failedGate: node.id };
  }
  return { satisfied: true };
}

/** Resolve the §3.4 retarget chain. Returns the first existing node id, or
 * null if no target resolves (run halts). */
export function resolveRetargetChain(graph: Graph, failedGateId: string): string | null {
  const gate = graph.nodes[failedGateId];
  const candidates: (string | undefined)[] = [
    gate?.attrs.retry_target,
    gate?.attrs.fallback_retry_target,
    graph.attrs.retry_target,
    graph.attrs.fallback_retry_target,
  ];
  for (const id of candidates) {
    if (typeof id === "string" && id !== "" && graph.nodes[id] != null) return id;
  }
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
}

/** Decide what to do when traversal reaches a terminal. Pure. */
export function goalGateStep(input: GoalGateInput): GoalGateAction {
  const check = checkGoalGates(input.graph, input.outcomes);
  if (check.satisfied) return { kind: "exit" };

  const cap = maxGoalGateRetries(input.graph.attrs);
  if (input.retries >= cap) {
    return { kind: "halt", reason: "goal_gate_unsatisfied", gate: check.failedGate };
  }

  const target = resolveRetargetChain(input.graph, check.failedGate);
  if (target == null) {
    return { kind: "halt", reason: "goal_gate_unsatisfied", gate: check.failedGate };
  }

  return { kind: "retarget", gate: check.failedGate, target, nextRetries: input.retries + 1 };
}
