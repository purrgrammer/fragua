import type { FactEvent, RunMetrics, RunState, RunStatus } from "./types.ts";

export function emptyMetrics(): RunMetrics {
  return {
    billedTokens: 0,
    totalCostUsd: 0,
    totalInputCostUsd: 0,
    totalOutputCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    loopCounts: {},
    models: {},
    nodeCosts: {},
    activeMs: 0,
  };
}

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>(["completed", "cancelled", "halted"]);

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
      // The first dispatch fires implicitly with run_started — no
      // separate fact.dispatch_started precedes it.
      next.dispatchStartedAt = now;
      if (fact.payload.baseGitSha !== undefined) {
        next.baseGitSha = fact.payload.baseGitSha;
      }
      return next;
    }
    case "fact.dispatch_started": {
      // Flip queued → running so the projection reflects "actively
      // executing" once the executor commits to the handler call.
      // Symmetrical with fact.run_started's status flip on the first
      // dispatch.
      if (next.status === "queued") next.status = "running";
      next.dispatchStartedAt = now;
      return next;
    }
    case "fact.node_started": {
      next.status = "running";
      next.currentNode = fact.payload.nodeId;
      next.nodeStartedAt = now;
      return next;
    }
    case "fact.node_completed": {
      closeDispatchInterval(next, now);
      const p = fact.payload;
      next.metrics.billedTokens += p.tokens;
      next.metrics.totalCostUsd += p.costUsd;
      next.metrics.totalInputCostUsd += p.inputCostUsd ?? 0;
      next.metrics.totalOutputCostUsd += p.outputCostUsd ?? 0;
      next.metrics.totalInputTokens += p.inputTokens ?? 0;
      next.metrics.totalOutputTokens += p.outputTokens ?? 0;
      next.metrics.totalCacheReadTokens += p.cacheReadTokens ?? 0;
      next.metrics.totalCacheWriteTokens += p.cacheWriteTokens ?? 0;
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
      next.metrics.loopCounts[p.nodeId] = (next.metrics.loopCounts[p.nodeId] ?? 0) + 1;
      const nodeBucket = next.metrics.nodeCosts[p.nodeId] ?? { tokens: 0, costUsd: 0 };
      next.metrics.nodeCosts[p.nodeId] = {
        tokens: nodeBucket.tokens + (p.inputTokens ?? 0) + (p.outputTokens ?? 0),
        costUsd: nodeBucket.costUsd + p.costUsd,
      };
      next.currentNode = p.nextNode;
      next.nodeStartedAt = now;
      return next;
    }
    case "fact.node_aborted": {
      closeDispatchInterval(next, now);
      const p = fact.payload;
      next.metrics.billedTokens += p.partialTokens;
      next.metrics.totalCostUsd += p.partialCostUsd;
      next.metrics.totalInputCostUsd += p.partialInputCostUsd ?? 0;
      next.metrics.totalOutputCostUsd += p.partialOutputCostUsd ?? 0;
      next.metrics.totalInputTokens += p.partialInputTokens ?? 0;
      next.metrics.totalOutputTokens += p.partialOutputTokens ?? 0;
      next.metrics.totalCacheReadTokens += p.partialCacheReadTokens ?? 0;
      next.metrics.totalCacheWriteTokens += p.partialCacheWriteTokens ?? 0;
      const abortBucket = next.metrics.nodeCosts[p.nodeId] ?? { tokens: 0, costUsd: 0 };
      next.metrics.nodeCosts[p.nodeId] = {
        tokens: abortBucket.tokens + (p.partialInputTokens ?? 0) + (p.partialOutputTokens ?? 0),
        costUsd: abortBucket.costUsd + p.partialCostUsd,
      };
      return next;
    }
    case "fact.run_paused_hitl": {
      closeDispatchInterval(next, now);
      next.status = "paused_hitl";
      next.nodeStartedAt = null;
      return next;
    }
    case "fact.run_paused": {
      closeDispatchInterval(next, now);
      // Only `provider_error` carries `policy`. Auto-retry policy →
      // paused_provider_retry (wake-pending auto-resumes once
      // `auto_resume_at` elapses). Everything else → paused (operator
      // must intent.resume).
      const policy = fact.payload.reason === "provider_error" ? fact.payload.policy : undefined;
      next.status = policy === "auto-retry" ? "paused_provider_retry" : "paused";
      next.nodeStartedAt = null;
      return next;
    }
    case "fact.run_paused_retry": {
      // Backoff between retries (attractor §3.5 / §3.6). The slot is
      // released so other queued runs can claim — wake-pending re-queues
      // this run once `payload.resumeAt` has elapsed.
      closeDispatchInterval(next, now);
      next.status = "paused_retry";
      next.nodeStartedAt = null;
      return next;
    }
    case "fact.run_resumed": {
      // Resumed from paused, paused_hitl, or quarantined. Go back to
      // queued so the executor's claim loop picks the run up and
      // re-dispatches the same node — `paused` (provider-error /
      // payment-required reasons) preserves the same iteration since
      // the prior LLM call never produced output. `dispatchStartedAt`
      // is already null (cleared by the prior pause); the next
      // fact.dispatch_started will set it fresh.
      next.status = "queued";
      next.nodeStartedAt = null;
      next.readyAt = now;
      return next;
    }
    case "fact.run_completed": {
      closeDispatchInterval(next, now);
      next.status = "completed";
      next.currentNode = fact.payload.finalNode;
      next.nodeStartedAt = null;
      return next;
    }
    case "fact.run_halted": {
      closeDispatchInterval(next, now);
      next.status = "halted";
      next.nodeStartedAt = null;
      return next;
    }
    case "fact.run_cancelled": {
      closeDispatchInterval(next, now);
      next.status = "cancelled";
      next.nodeStartedAt = null;
      return next;
    }
    case "fact.run_quarantined": {
      closeDispatchInterval(next, now);
      next.status = "quarantined";
      next.nodeStartedAt = null;
      return next;
    }
    case "fact.run_branched": {
      next.branch = fact.payload.branch;
      return next;
    }
    case "fact.run_requeued_after_crash": {
      // If sweep captured the dying daemon's last heartbeat, use it as a
      // tight upper bound on real active time (heartbeat updates ~every 5s,
      // so this gives crash-time accuracy within ~5s). Otherwise fall back
      // to dropping the pre-crash span entirely — we can't tell active
      // time from dead-daemon time.
      if (next.dispatchStartedAt != null) {
        const lastAlive = (fact.payload as { lastAliveAt?: number }).lastAliveAt;
        if (typeof lastAlive === "number" && lastAlive > next.dispatchStartedAt) {
          next.metrics.activeMs += lastAlive - next.dispatchStartedAt;
        }
        next.dispatchStartedAt = null;
      }
      next.status = "queued";
      next.currentNode = null;
      next.nodeStartedAt = null;
      next.readyAt = now;
      return next;
    }
    // Events that don't change projection scalars:
    case "fact.intents_folded":
    case "fact.side_effect_intent":
    case "fact.side_effect_done":
    case "fact.side_effect_failed":
    case "fact.tool_completed":
    case "fact.message_appended":
    case "fact.handler_timeout_leaked":
    case "fact.daemon_takeover":
    case "fact.provider_retry_attempted":
      return next;
  }
}

export function foldFacts(initial: RunState, facts: FactEvent[], now: number): RunState {
  let state = initial;
  for (const f of facts) state = applyFact(state, f, now);
  return state;
}

function closeDispatchInterval(next: RunState, now: number): void {
  if (next.dispatchStartedAt != null) {
    next.metrics.activeMs += now - next.dispatchStartedAt;
    next.dispatchStartedAt = null;
  }
}

function cloneMetrics(m: RunMetrics): RunMetrics {
  const models: Record<string, { tokens: number; costUsd: number }> = {};
  for (const [k, v] of Object.entries(m.models)) {
    models[k] = { tokens: v.tokens, costUsd: v.costUsd };
  }
  const nodeCosts: Record<string, { tokens: number; costUsd: number }> = {};
  for (const [k, v] of Object.entries(m.nodeCosts ?? {})) {
    nodeCosts[k] = { tokens: v.tokens, costUsd: v.costUsd };
  }
  return {
    billedTokens: m.billedTokens,
    totalCostUsd: m.totalCostUsd,
    totalInputCostUsd: m.totalInputCostUsd ?? 0,
    totalOutputCostUsd: m.totalOutputCostUsd ?? 0,
    totalInputTokens: m.totalInputTokens,
    totalOutputTokens: m.totalOutputTokens,
    totalCacheReadTokens: m.totalCacheReadTokens,
    totalCacheWriteTokens: m.totalCacheWriteTokens,
    loopCounts: { ...m.loopCounts },
    models,
    nodeCosts,
    activeMs: m.activeMs ?? 0,
  };
}
