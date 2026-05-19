// Budget policy — read-and-enforce. Pure module.
//
// Inputs are everything the executor knows at the post-handler boundary
// (just-completed node, cumulative spend including this turn, configured
// ceilings, already-warned tags). Output is a small typed decision the
// executor turns into observability events + an optional halt.
//
// Precedence:
//   1. run.cost
//   2. run.tokens
//   3. node.cost
//   4. node.tokens
// First breach wins for the stop branch — only one stop event + halt
// per turn. Warns can stack (one per (scope, metric) per run, then
// silenced via the `__budget_warned` routing tag).
//
// `budget_policy` decides what happens on first breach:
//   "pause" (default) — `shouldPause` set; executor emits
//     `fact.run_paused{reason:"budget", scope, metric, limit, actual}`.
//   "stop"            — `shouldHalt` set; executor emits the budget halt.
//   "warn"            — non-blocking; just the events fire.

import type { GraphAttrs, NodeAttrs } from "../types/graph.ts";

export const BUDGET_WARN_RATIO = 0.8;

export interface BudgetInput {
  graphAttrs: GraphAttrs;
  /** Attrs of the just-completed node. May be undefined when the node
   * is synthetic (e.g. summariser-driven dispatches with no graph entry). */
  completedNodeAttrs?: NodeAttrs;
  completedNodeId: string;
  /** Cumulative cost across the run AFTER this turn's cost is applied
   * (executor passes `state.metrics.totalCostUsd + result.costUsd`). */
  cumulativeCostUsd: number;
  cumulativeTokens: number;
  /** Per-node cumulative cost AFTER this turn (executor adds the just-
   * completed turn's cost to the prior bucket). */
  nodeCumulativeCostUsd: number;
  nodeCumulativeTokens: number;
  /** Tags from `run_state.routing.__budget_warned`. Used to suppress
   * repeat warns for the same (scope, metric). */
  alreadyWarned: ReadonlySet<string>;
  /** Operator-supplied ceiling overrides folded from `intent.budget_adjusted`,
   * read from `run_state.routing.budget_override.<scope>.<metric>`. When
   * set for a (scope, metric), replaces the corresponding `graph.attrs.budget_*`
   * / `node.attrs.max_*` ceiling for this turn's evaluation. */
  overrides?: {
    run?: { cost?: number; tokens?: number };
    node?: { cost?: number; tokens?: number };
  };
}

export interface BudgetDecision {
  /** Observability events to emit (`budget.warn` and/or `budget.stop`). */
  events: BudgetObservabilityEvent[];
  /** Halt the run with reason="budget" when true. Set only when
   * `budget_policy="stop"` and a breach fired. */
  shouldHalt: boolean;
  /** Populates `fact.run_halted.detail`. */
  haltReason?: string;
  /** Pause the run with `fact.run_paused{reason:"budget"}` when set.
   * Mutually exclusive with `shouldHalt` — `budget_policy="pause"` (the
   * default) breaches go here; `budget_policy="stop"` breaches go to
   * `shouldHalt`. The payload is the breach detail the executor needs
   * to construct the fact. */
  pauseBreach?: {
    scope: "run" | "node";
    metric: "cost" | "tokens";
    limit: number;
    actual: number;
  };
  /** Tags to merge into `routing.__budget_warned` so the same warn doesn't
   * fire twice on later turns. Empty when nothing fired. */
  newlyWarned: string[];
}

export interface BudgetObservabilityEvent {
  type: string;
  payload: Record<string, unknown>;
}

interface Check {
  scope: "run" | "node";
  metric: "cost" | "tokens";
  cumulative: number;
  ceiling: number;
  tag: string;
}

/**
 * Evaluate budget breach state at a turn boundary. Pure. Same input → same
 * output; no I/O, no clock, no randomness.
 */
export function evaluateBudget(input: BudgetInput): BudgetDecision {
  const checks = collectChecks(input);
  if (checks.length === 0) {
    return { events: [], shouldHalt: false, newlyWarned: [] };
  }

  const policy = input.graphAttrs.budget_policy ?? "pause";
  const events: BudgetObservabilityEvent[] = [];
  const newlyWarned: string[] = [];
  let stopFired = false;
  let haltReason: string | undefined;
  let firstBreach: Check | undefined;

  for (const c of checks) {
    if (c.cumulative >= c.ceiling) {
      // Stop: first breach wins; later breaches don't pile on.
      if (stopFired) continue;
      events.push({
        type: "budget.stop",
        payload: {
          scope: c.scope,
          metric: c.metric,
          limit: c.ceiling,
          actual: c.cumulative,
          ...(c.scope === "node" ? { caller_node_id: input.completedNodeId } : {}),
          ...(input.graphAttrs.budget_usd !== undefined ? { run_max_cost_usd: input.graphAttrs.budget_usd } : {}),
          reason: stopReason(c, input.completedNodeId),
        },
      });
      stopFired = true;
      firstBreach = c;
      haltReason = stopReason(c, input.completedNodeId);
    } else if (c.cumulative >= c.ceiling * BUDGET_WARN_RATIO && !input.alreadyWarned.has(c.tag)) {
      // Warn: once per (scope, metric) per run.
      events.push({
        type: "budget.warn",
        payload: {
          scope: c.scope,
          metric: c.metric,
          limit: c.ceiling,
          actual: c.cumulative,
          ratio: c.cumulative / c.ceiling,
          ...(c.scope === "node" ? { caller_node_id: input.completedNodeId } : {}),
          ...(input.graphAttrs.budget_usd !== undefined ? { run_max_cost_usd: input.graphAttrs.budget_usd } : {}),
          reason: warnReason(c, input.completedNodeId),
        },
      });
      newlyWarned.push(c.tag);
    }
  }

  const shouldHalt = stopFired && policy === "stop";
  const shouldPause = stopFired && policy === "pause";
  const decision: BudgetDecision = {
    events,
    shouldHalt,
    newlyWarned,
  };
  if (shouldHalt && haltReason !== undefined) decision.haltReason = haltReason;
  if (shouldPause && firstBreach !== undefined) {
    decision.pauseBreach = {
      scope: firstBreach.scope,
      metric: firstBreach.metric,
      limit: firstBreach.ceiling,
      actual: firstBreach.cumulative,
    };
  }
  return decision;
}

function collectChecks(input: BudgetInput): Check[] {
  const out: Check[] = [];
  const ovRun = input.overrides?.run;
  const ovNode = input.overrides?.node;
  // Run-level (priority 1, 2). Override wins over graph.attrs.
  const runCostCeiling = ovRun?.cost ?? input.graphAttrs.budget_usd;
  if (typeof runCostCeiling === "number") {
    out.push({
      scope: "run",
      metric: "cost",
      cumulative: input.cumulativeCostUsd,
      ceiling: runCostCeiling,
      tag: "run:cost",
    });
  }
  const runTokensCeiling = ovRun?.tokens;
  if (typeof runTokensCeiling === "number") {
    out.push({
      scope: "run",
      metric: "tokens",
      cumulative: input.cumulativeTokens,
      ceiling: runTokensCeiling,
      tag: "run:tokens",
    });
  }
  // Node-level (priority 3, 4). Override wins over node.attrs.
  const nodeAttrs = input.completedNodeAttrs;
  const nodeCostCeiling = ovNode?.cost ?? nodeAttrs?.max_cost_usd;
  if (typeof nodeCostCeiling === "number") {
    out.push({
      scope: "node",
      metric: "cost",
      cumulative: input.nodeCumulativeCostUsd,
      ceiling: nodeCostCeiling,
      tag: `node:${input.completedNodeId}:cost`,
    });
  }
  const nodeTokensCeiling = ovNode?.tokens ?? nodeAttrs?.max_tokens;
  if (typeof nodeTokensCeiling === "number") {
    out.push({
      scope: "node",
      metric: "tokens",
      cumulative: input.nodeCumulativeTokens,
      ceiling: nodeTokensCeiling,
      tag: `node:${input.completedNodeId}:tokens`,
    });
  }
  return out;
}

function warnReason(c: Check, nodeId: string): string {
  const pct = Math.round((c.cumulative / c.ceiling) * 100);
  if (c.scope === "run") {
    return `run ${c.metric} at ${pct}% of ${c.ceiling} (cumulative ${c.cumulative})`;
  }
  return `node ${nodeId} ${c.metric} at ${pct}% of ${c.ceiling} (cumulative ${c.cumulative})`;
}

function stopReason(c: Check, nodeId: string): string {
  if (c.scope === "run") {
    return `run ${c.metric} budget exhausted: ${c.cumulative} >= ${c.ceiling}`;
  }
  return `node ${nodeId} ${c.metric} budget exhausted: ${c.cumulative} >= ${c.ceiling}`;
}
