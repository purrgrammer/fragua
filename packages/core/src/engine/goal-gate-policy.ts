// Goal-gate policy reducer — attractor-spec §3.4.
//
// When traversal reaches a terminal (exit), every node visited with
// `goal_gate=true` must have settled in SUCCESS or PARTIAL_SUCCESS for the
// run to exit cleanly. If any gate is unsatisfied, route to the failed
// gate's `retry_target`; if that's unset, the run halts with
// `goal_gate_unsatisfied`. Single-step — there is no graph-level or
// fallback retarget.
//
// Fragua caps each retarget loop with the failing gate's own `max_retries`
// so a misconfigured retry target can't burn the run forever. The cap is
// required (E031) on every step authored via `retry:`. Operators raise the
// live cap via `intent.goal_gate_adjusted` → `routing.max_goal_gate_retries_override`.
//
// This module is the pure reducer the executor consults. Property tests
// exercise the chain without spinning the executor.

import type { GateOutcomes } from "../routing.ts";
import type { Graph } from "../types/graph.ts";

// The per-gate routing keys (`goal_gates.*`) and their validate-and-degrade
// readers (`goalGateOutcomeKey`, `readGateOutcomes`, `readGoalGateRetries`,
// `GOAL_GATE_RETRIES_KEY`, `GOAL_GATE_OUTCOME_KEY_PREFIX`) live in
// `../routing.ts`, the typed-routing accessor module. `GateOutcomes` is
// re-exported there too; this module keeps the pure graph logic.
export type { GateOutcomes };

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

export type GoalGateAction =
  /** All gates satisfied — let the terminal exit emit `fact.run_terminated{completed}`. */
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
  /** The failing gate node's own `max_retries` value (required on every
   * `retry:` gate via E031). The executor reads this from the gate node
   * and passes it in explicitly so the policy stays pure. */
  gateCap: number;
  /** Operator override for the per-gate retarget cap, threaded by the
   * executor from `routing.max_goal_gate_retries_override` (set via
   * `intent.goal_gate_adjusted`). Takes precedence over `gateCap`. */
  capOverride?: number;
}

/** Decide what to do when traversal reaches a terminal. Pure. */
export function goalGateStep(input: GoalGateInput): GoalGateAction {
  const check = checkGoalGates(input.graph, input.outcomes);
  if (check.satisfied) return { kind: "exit" };

  const cap = input.capOverride && input.capOverride > 0 ? input.capOverride : input.gateCap;
  if (input.retries >= cap) {
    return { kind: "halt", reason: "goal_gate_unsatisfied", gate: check.failedGate };
  }

  const target = resolveRetargetChain(input.graph, check.failedGate);
  if (target == null) {
    return { kind: "halt", reason: "goal_gate_unsatisfied", gate: check.failedGate };
  }

  return { kind: "retarget", gate: check.failedGate, target, nextRetries: input.retries + 1 };
}
