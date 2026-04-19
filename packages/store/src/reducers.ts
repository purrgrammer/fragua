import type { FactEvent, RunMetrics, RunState, RunStatus } from "./types.ts";

export function emptyMetrics(): RunMetrics {
  return {
    totalTokens: 0,
    totalCostUsd: 0,
    loopCounts: {},
    models: {},
  };
}

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "cancelled",
  "halted",
]);

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * Pure reducer: apply a single fact event to an in-memory projection.
 *
 * The store uses this for debug/replay and to derive the authoritative update
 * written inside `appendFact`. Handlers never call this directly.
 */
export function applyFact(state: RunState, fact: FactEvent, now: number): RunState {
  const next: RunState = {
    ...state,
    metrics: cloneMetrics(state.metrics),
    routing: { ...state.routing },
    updatedAt: now,
  };

  switch (fact.type) {
    case "fact.run_started": {
      next.status = "running";
      next.currentNode = fact.payload.startNode;
      next.nodeStartedAt = now;
      return next;
    }
    case "fact.node_started": {
      next.status = "running";
      next.currentNode = fact.payload.nodeId;
      next.nodeStartedAt = now;
      return next;
    }
    case "fact.node_completed": {
      const p = fact.payload;
      next.metrics.totalTokens += p.tokens;
      next.metrics.totalCostUsd += p.costUsd;
      if (p.modelName) {
        const bucket = next.metrics.models[p.modelName] ?? {
          tokens: 0,
          costUsd: 0,
        };
        next.metrics.models[p.modelName] = {
          tokens: bucket.tokens + p.tokens,
          costUsd: bucket.costUsd + p.costUsd,
        };
      }
      next.metrics.loopCounts[p.nodeId] =
        (next.metrics.loopCounts[p.nodeId] ?? 0) + 1;
      next.currentNode = p.nextNode;
      next.nodeStartedAt = now;
      return next;
    }
    case "fact.node_aborted": {
      next.metrics.totalTokens += fact.payload.partialTokens;
      next.metrics.totalCostUsd += fact.payload.partialCostUsd;
      return next;
    }
    case "fact.run_paused_hitl": {
      next.status = "paused_hitl";
      next.nodeStartedAt = null;
      return next;
    }
    case "fact.run_resumed": {
      next.status = "running";
      next.nodeStartedAt = now;
      return next;
    }
    case "fact.run_completed": {
      next.status = "completed";
      next.currentNode = fact.payload.finalNode;
      next.nodeStartedAt = null;
      return next;
    }
    case "fact.run_halted": {
      next.status = "halted";
      next.nodeStartedAt = null;
      return next;
    }
    case "fact.run_cancelled": {
      next.status = "cancelled";
      next.nodeStartedAt = null;
      return next;
    }
    case "fact.run_quarantined": {
      next.status = "quarantined";
      next.nodeStartedAt = null;
      return next;
    }
    case "fact.run_requeued_after_crash": {
      next.status = "queued";
      next.currentNode = null;
      next.nodeStartedAt = null;
      next.readyAt = now;
      return next;
    }
    // Events that don't change projection scalars:
    case "fact.steering_applied":
    case "fact.side_effect_intent":
    case "fact.side_effect_done":
    case "fact.side_effect_failed":
    case "fact.tool_completed":
    case "fact.message_appended":
    case "fact.handler_timeout_leaked":
    case "fact.daemon_takeover":
      return next;
  }
}

export function foldFacts(
  initial: RunState,
  facts: FactEvent[],
  now: number,
): RunState {
  let state = initial;
  for (const f of facts) state = applyFact(state, f, now);
  return state;
}

function cloneMetrics(m: RunMetrics): RunMetrics {
  const models: Record<string, { tokens: number; costUsd: number }> = {};
  for (const [k, v] of Object.entries(m.models)) {
    models[k] = { tokens: v.tokens, costUsd: v.costUsd };
  }
  return {
    totalTokens: m.totalTokens,
    totalCostUsd: m.totalCostUsd,
    loopCounts: { ...m.loopCounts },
    models,
  };
}
