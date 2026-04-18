// BudgetLedger — pure reducer over cost.recorded events. Lives in core
// so both the executor (which emits warn/stop events + hands snapshots
// to backends) and the agent layer (which needs the cumulative values
// on `llm.start.budget`) read from the same source of truth.
//
// Not a stateful subscriber: the executor just calls `record()` after
// it writes a cost.recorded event and `snapshot(nodeId)` before it
// hands a CodergenInput to the backend. Keeps the engine deterministic
// for replay.

import type { Event } from "../types/events.ts";

/** Raw delta extracted from a `cost.recorded` event's data. */
export interface CostDelta {
  /** Which real or synthetic node the cost belongs to. Synthetic
   * summariser calls ride under `__summary.*` and are bucketed there
   * so a node's per-node ceiling isn't charged for the summariser
   * compressions it triggers. */
  node_id: string | undefined;
  cost_usd: number;
  total_tokens: number;
}

/** Cumulative + per-node totals at a point in time. */
export interface LedgerSnapshot {
  cumulative_cost_usd: number;
  cumulative_tokens: number;
  per_node_cost_usd: Record<string, number>;
  per_node_tokens: Record<string, number>;
}

export interface BudgetLimits {
  /** Node-level cost ceiling from `node.attrs.max_cost_usd`. */
  node_max_cost_usd?: number;
  /** Node-level token ceiling from `node.attrs.max_tokens`. */
  node_max_tokens?: number;
  /** Run-level cost ceiling from `graph.attrs.budget_usd`. */
  run_max_cost_usd?: number;
  /** Run-level token ceiling from `graph.attrs.budget_tokens`. */
  run_max_tokens?: number;
}

/** Cost snapshot shaped for the caller (backend, `llm.start.budget`). */
export interface BudgetQuery {
  cumulative_cost_usd: number;
  cumulative_tokens: number;
  node_cost_usd: number;
  node_tokens: number;
  max_cost_usd?: number;
  max_tokens?: number;
  run_max_cost_usd?: number;
  run_max_tokens?: number;
}

/** What the executor should do next after a cost.recorded delta. */
export type BudgetVerdict =
  | { kind: "ok" }
  | {
      kind: "warn";
      reason: string;
      scope: "node" | "run";
      metric: "cost" | "tokens";
      limit: number;
      actual: number;
      ratio: number;
    }
  | { kind: "stop"; reason: string; scope: "node" | "run"; metric: "cost" | "tokens"; limit: number; actual: number };

/** Threshold above which `budget.warn` fires. Fraction of the ceiling.
 * Exposed so tests can override and stay deterministic. */
export const DEFAULT_WARN_THRESHOLD = 0.8;

export class BudgetLedger {
  private runCost = 0;
  private runTokens = 0;
  private readonly nodeCost = new Map<string, number>();
  private readonly nodeTokens = new Map<string, number>();
  /** Per-(nodeId | "__run__") × (cost | tokens) latched-warning flags so
   * we fire `budget.warn` once per threshold crossing, not on every
   * delta after. */
  private readonly warnedCost = new Set<string>();
  private readonly warnedTokens = new Set<string>();
  /** Same for stop — once a scope has stopped, further record() calls
   * don't re-emit (but the verdict still reports `stop`). */
  private readonly stoppedCost = new Set<string>();
  private readonly stoppedTokens = new Set<string>();
  private readonly warnThreshold: number;

  constructor(opts: { warnThreshold?: number } = {}) {
    this.warnThreshold = opts.warnThreshold ?? DEFAULT_WARN_THRESHOLD;
  }

  /** Apply a delta, return what (if anything) the executor should emit.
   * Returns the FIRST breach detected across (node,cost), (node,tokens),
   * (run,cost), (run,tokens). The executor records the delta AFTER each
   * cost.recorded event so the check sees the post-delta cumulative. */
  record(delta: CostDelta, limits: BudgetLimits): BudgetVerdict {
    const nodeId = delta.node_id;
    if (nodeId) {
      this.nodeCost.set(nodeId, (this.nodeCost.get(nodeId) ?? 0) + Math.max(0, delta.cost_usd));
      this.nodeTokens.set(nodeId, (this.nodeTokens.get(nodeId) ?? 0) + Math.max(0, delta.total_tokens));
    }
    this.runCost += Math.max(0, delta.cost_usd);
    this.runTokens += Math.max(0, delta.total_tokens);

    // Check node-scope breaches first (they're more specific).
    if (nodeId) {
      const nc = this.nodeCost.get(nodeId) ?? 0;
      const nt = this.nodeTokens.get(nodeId) ?? 0;
      const nodeCostVerdict = this.check("node", "cost", nodeId, nc, limits.node_max_cost_usd);
      if (nodeCostVerdict.kind !== "ok") return nodeCostVerdict;
      const nodeTokensVerdict = this.check("node", "tokens", nodeId, nt, limits.node_max_tokens);
      if (nodeTokensVerdict.kind !== "ok") return nodeTokensVerdict;
    }
    const runCostVerdict = this.check("run", "cost", "__run__", this.runCost, limits.run_max_cost_usd);
    if (runCostVerdict.kind !== "ok") return runCostVerdict;
    const runTokensVerdict = this.check("run", "tokens", "__run__", this.runTokens, limits.run_max_tokens);
    if (runTokensVerdict.kind !== "ok") return runTokensVerdict;
    return { kind: "ok" };
  }

  /** Pre-flight check without consuming a delta. Used by the executor
   * just before handing a CodergenInput to the backend — if the current
   * cumulative already breaches a ceiling (from prior calls), the
   * backend gets `shouldStop=true` and can refuse to call the LLM. */
  preflight(nodeId: string, limits: BudgetLimits): BudgetVerdict {
    const nc = this.nodeCost.get(nodeId) ?? 0;
    const nt = this.nodeTokens.get(nodeId) ?? 0;
    const nodeCost = this.check("node", "cost", nodeId, nc, limits.node_max_cost_usd);
    if (nodeCost.kind === "stop") return nodeCost;
    const nodeTok = this.check("node", "tokens", nodeId, nt, limits.node_max_tokens);
    if (nodeTok.kind === "stop") return nodeTok;
    const runCost = this.check("run", "cost", "__run__", this.runCost, limits.run_max_cost_usd);
    if (runCost.kind === "stop") return runCost;
    const runTok = this.check("run", "tokens", "__run__", this.runTokens, limits.run_max_tokens);
    if (runTok.kind === "stop") return runTok;
    return { kind: "ok" };
  }

  /** Read-only snapshot shaped for `llm.start.budget` on a given node. */
  query(nodeId: string, limits: BudgetLimits): BudgetQuery {
    const q: BudgetQuery = {
      cumulative_cost_usd: round6(this.runCost),
      cumulative_tokens: this.runTokens,
      node_cost_usd: round6(this.nodeCost.get(nodeId) ?? 0),
      node_tokens: this.nodeTokens.get(nodeId) ?? 0,
    };
    if (limits.node_max_cost_usd !== undefined) q.max_cost_usd = limits.node_max_cost_usd;
    if (limits.node_max_tokens !== undefined) q.max_tokens = limits.node_max_tokens;
    if (limits.run_max_cost_usd !== undefined) q.run_max_cost_usd = limits.run_max_cost_usd;
    if (limits.run_max_tokens !== undefined) q.run_max_tokens = limits.run_max_tokens;
    return q;
  }

  snapshot(): LedgerSnapshot {
    return {
      cumulative_cost_usd: round6(this.runCost),
      cumulative_tokens: this.runTokens,
      per_node_cost_usd: Object.fromEntries([...this.nodeCost.entries()].map(([k, v]) => [k, round6(v)])),
      per_node_tokens: Object.fromEntries(this.nodeTokens.entries()),
    };
  }

  private check(
    scope: "node" | "run",
    metric: "cost" | "tokens",
    key: string,
    actual: number,
    limit: number | undefined,
  ): BudgetVerdict {
    if (limit === undefined || limit <= 0) return { kind: "ok" };
    const stopSet = metric === "cost" ? this.stoppedCost : this.stoppedTokens;
    const warnSet = metric === "cost" ? this.warnedCost : this.warnedTokens;
    if (actual >= limit) {
      const latchKey = `${scope}:${key}`;
      if (!stopSet.has(latchKey)) {
        stopSet.add(latchKey);
        return {
          kind: "stop",
          scope,
          metric,
          limit,
          actual: round6(actual),
          reason: `${scope} ${metric} ceiling ${formatLimit(metric, limit)} exceeded (actual ${formatLimit(metric, actual)})`,
        };
      }
      // Already stopped — still return stop so the executor blocks
      // further calls, but the emitter should de-dupe on first landing.
      return {
        kind: "stop",
        scope,
        metric,
        limit,
        actual: round6(actual),
        reason: `${scope} ${metric} ceiling still exceeded`,
      };
    }
    const ratio = actual / limit;
    if (ratio >= this.warnThreshold) {
      const latchKey = `${scope}:${key}`;
      if (!warnSet.has(latchKey)) {
        warnSet.add(latchKey);
        return {
          kind: "warn",
          scope,
          metric,
          limit,
          actual: round6(actual),
          ratio: round6(ratio),
          reason: `${scope} ${metric} at ${Math.round(ratio * 100)}% of ceiling ${formatLimit(metric, limit)}`,
        };
      }
    }
    return { kind: "ok" };
  }
}

/** Helper: extract the fields we care about from a cost.recorded event. */
export function costDeltaFromEvent(ev: Event): CostDelta | undefined {
  if (ev.type !== "cost.recorded") return undefined;
  const d = ev.data as { cost_usd?: unknown; total_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown };
  const cost = typeof d.cost_usd === "number" ? d.cost_usd : 0;
  const total =
    typeof d.total_tokens === "number"
      ? d.total_tokens
      : (typeof d.input_tokens === "number" ? d.input_tokens : 0) +
        (typeof d.output_tokens === "number" ? d.output_tokens : 0);
  return { node_id: ev.node_id, cost_usd: cost, total_tokens: total };
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function formatLimit(metric: "cost" | "tokens", value: number): string {
  return metric === "cost" ? `$${round6(value)}` : `${value} tokens`;
}
