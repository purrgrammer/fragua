import type { RunEnqueuedPayload } from "@fragua/types";
import { AUTO_WAKE_PAUSE_REASONS, type FactEvent, type RunMetrics, type RunState } from "./types.ts";

/** The active-set frontier of an in-flight `type: parallel` fan-out (Model A,
 * docs/proposals/fan-out-nodes.md). The set of sub-node ids currently in flight
 * across all branches. Stored in `run_state.routing` (an `internal.*`
 * projection key, like `internal.auto_resume_at`) rather than a dedicated
 * column — foldable from the log, riding the already-plumbed routing
 * serialization, so no schema migration. Seeded by `fact.fanout_started` (the
 * branch entries), advanced atomically per sub-node (a `fact.node_completed`
 * removes the done node, a bundled `fact.dispatch_started` adds its successor),
 * cleared by `fact.fanout_joined`. `null` ⇒ no fan-out in flight. */
export const ACTIVE_NODES_ROUTING_KEY = "internal.active_nodes";

export function readActiveNodes(routing: Record<string, unknown>): string[] | null {
  const v = routing[ACTIVE_NODES_ROUTING_KEY];
  // Element-validated: the only non-typed write path is a tampered bundle fed
  // through `fragua import` — fail to "no fan-out" instead of propagating junk.
  return Array.isArray(v) && v.every((e) => typeof e === "string") ? (v as string[]) : null;
}

export function emptyMetrics(): RunMetrics {
  return {
    billedTokens: 0,
    totalCostUsd: 0,
    totalInputCostUsd: 0,
    totalOutputCostUsd: 0,
    totalCacheReadCostUsd: 0,
    totalCacheWriteCostUsd: 0,
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
      if (fact.payload.baseGitRef !== undefined) {
        next.baseGitRef = fact.payload.baseGitRef;
      }
      return next;
    }
    case "fact.dispatch_started": {
      // Flip queued → running so the projection reflects "actively
      // executing" once the executor commits to the handler call.
      // Symmetrical with fact.run_started's status flip on the first
      // dispatch.
      if (next.status === "queued") next.status = "running";
      // Open the dispatch interval only when one isn't already open: during a
      // fan-out the interval spans the whole region (fan entry → join /
      // park), and a bundled successor dispatch_started overwriting the
      // anchor would silently drop the span accrued so far.
      if (next.dispatchStartedAt == null) next.dispatchStartedAt = now;
      // Frontier advance: a sub-node dispatched inside a live fan-out joins the
      // active set (the executor bundles this with the predecessor's
      // `node_completed` in one commit, so the frontier never loses a
      // successor across a crash — I1). The parallel node's own dispatch fires
      // before `fanout_started`, when the set is null, so it is unaffected.
      const active = readActiveNodes(next.routing);
      if (active !== null && !active.includes(fact.payload.nodeId)) {
        next.routing[ACTIVE_NODES_ROUTING_KEY] = [...active, fact.payload.nodeId];
      }
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
      // Close the dispatch interval only for LINEAR completions. A fan-out
      // branch completion must not close it: the first finisher would null
      // the anchor, every concurrent sibling's close would then no-op, and
      // activeMs accrued only fan-entry → first completion. The region's
      // interval closes at `fact.fanout_joined` (or a pause/halt) instead.
      if (!readActiveNodes(next.routing)?.includes(p.nodeId)) {
        closeDispatchInterval(next, now);
      }
      next.metrics.billedTokens += p.tokens;
      next.metrics.totalCostUsd += p.costUsd;
      next.metrics.totalInputCostUsd += p.inputCostUsd ?? 0;
      next.metrics.totalOutputCostUsd += p.outputCostUsd ?? 0;
      next.metrics.totalCacheReadCostUsd += p.cacheReadCostUsd ?? 0;
      next.metrics.totalCacheWriteCostUsd += p.cacheWriteCostUsd ?? 0;
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
      // Fan-out frontier sub-node: remove it from the active set and keep
      // `current_node` PINNED to the parallel node (the barrier advances it).
      // Its successor — if any — was dispatched in this same commit (a bundled
      // `dispatch_started` re-added it above). A linear completion advances the
      // run pointer as usual.
      const activeOnComplete = readActiveNodes(next.routing);
      if (activeOnComplete?.includes(p.nodeId)) {
        next.routing[ACTIVE_NODES_ROUTING_KEY] = activeOnComplete.filter((n) => n !== p.nodeId);
      } else {
        next.currentNode = p.nextNode;
        next.nodeStartedAt = now;
      }
      return next;
    }
    case "fact.node_aborted": {
      const p = fact.payload;
      // Same linear-only close as node_completed: an aborted fan-out branch
      // stays in the active set while its siblings keep running.
      if (!readActiveNodes(next.routing)?.includes(p.nodeId)) {
        closeDispatchInterval(next, now);
      }
      next.metrics.billedTokens += p.partialTokens;
      next.metrics.totalCostUsd += p.partialCostUsd;
      next.metrics.totalInputCostUsd += p.partialInputCostUsd ?? 0;
      next.metrics.totalOutputCostUsd += p.partialOutputCostUsd ?? 0;
      next.metrics.totalCacheReadCostUsd += p.partialCacheReadCostUsd ?? 0;
      next.metrics.totalCacheWriteCostUsd += p.partialCacheWriteCostUsd ?? 0;
      next.metrics.totalInputTokens += p.partialInputTokens ?? 0;
      next.metrics.totalOutputTokens += p.partialOutputTokens ?? 0;
      next.metrics.totalCacheReadTokens += p.partialCacheReadTokens ?? 0;
      next.metrics.totalCacheWriteTokens += p.partialCacheWriteTokens ?? 0;
      const abortBucket = next.metrics.nodeCosts[p.nodeId] ?? { tokens: 0, costUsd: 0 };
      next.metrics.nodeCosts[p.nodeId] = {
        tokens: abortBucket.tokens + (p.partialInputTokens ?? 0) + (p.partialOutputTokens ?? 0),
        costUsd: abortBucket.costUsd + p.partialCostUsd,
      };
      // A fan-out sub-node that aborted stays in the active set — the executor
      // re-dispatches it on the next re-drive. (No active-set mutation here.)
      return next;
    }
    case "fact.fanout_started": {
      // Seed the frontier with the branch entries. `current_node` stays pinned
      // to the parallel node (`fact.payload.nodeId`); the frontier is the truth
      // for "what is running" until the barrier.
      next.routing[ACTIVE_NODES_ROUTING_KEY] = [...fact.payload.branches];
      next.status = "running";
      return next;
    }
    case "fact.fanout_joined": {
      // Barrier: the frontier drained. Clear it and advance `current_node` to
      // the join in this same commit (I1).
      closeDispatchInterval(next, now);
      delete next.routing[ACTIVE_NODES_ROUTING_KEY];
      next.currentNode = fact.payload.nextNode;
      next.nodeStartedAt = now;
      return next;
    }
    case "fact.run_paused_human": {
      closeDispatchInterval(next, now);
      next.status = "paused_human";
      next.nodeStartedAt = null;
      return next;
    }
    case "fact.run_paused": {
      closeDispatchInterval(next, now);
      // Status follows reason 1:1: AUTO_WAKE_PAUSE_REASONS → paused_auto
      // (daemon timer; wake-pending sweeps `auto_resume_at`); everything
      // else → paused (operator must `intent.resume`).
      next.status = AUTO_WAKE_PAUSE_REASONS.has(fact.payload.reason) ? "paused_auto" : "paused";
      next.nodeStartedAt = null;
      return next;
    }
    case "fact.run_resumed": {
      // Resumed from paused, paused_human, or quarantined. Go back to
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
      next.currentNode = null;
      next.nodeStartedAt = null;
      return next;
    }
    // Operator post-run primitives. branch / commit / merge are composable
    // and leave the inbox `acted`; discard is
    // terminal-terminal (`discarded`). The handler enforces the state machine
    // (refusing actions after discard); the reducer just projects.
    case "fact.run_accepted": {
      next.acceptedSha = fact.payload.sha;
      next.inboxStatus = "acted";
      return next;
    }
    case "fact.run_discarded": {
      next.inboxStatus = "discarded";
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
    case "fact.snapshot_recorded": {
      // Terminal worktree snapshot → inbox + diff projection.
      next.finalGitSha = fact.payload.headSha;
      next.finalHeadRef = fact.payload.headRef;
      next.diffBaseSha = fact.payload.diffBaseSha;
      const hasStat = fact.payload.committed !== null || fact.payload.uncommitted !== null;
      next.changeStat = hasStat ? { committed: fact.payload.committed, uncommitted: fact.payload.uncommitted } : null;
      // Inbox gate is recoverable AGENT work, not "diff vs base != 0".
      // Committed work counts as the run's own only when the worktree ended on
      // the provisioned, detached line: `headRef === null`. A named branch
      // means the workflow CHECKED OUT existing commits (e.g. a review run that
      // `git checkout`s the branch under review) — base..HEAD is then that
      // branch's content, not agent-authored work, even when it descends from
      // base (so `diffBaseSha == baseGitSha` and the relocation check alone
      // misses it). Uncommitted dirt is always the agent's, branch or not.
      const relocated = fact.payload.diffBaseSha !== next.baseGitSha;
      const committedIsAgentWork = fact.payload.committed !== null && !relocated && fact.payload.headRef === null;
      const recoverable = fact.payload.uncommitted !== null || committedIsAgentWork;
      next.inboxStatus = recoverable ? "pending" : null;
      return next;
    }
  }
  return next;
}

// contract: no-bump — the genesis payload enrichment is read only by this seed
// at enqueue/import time, never re-folded at resume (genesis is projection-level,
// applied once). Cross-version resume fold semantics over facts are unchanged.
/**
 * Seed an initial `run_state` from the genesis `intent.run_enqueued` payload —
 * the run as of enqueue (status `queued`), before any fact. `foldFacts` evolves
 * it. Together they reconstruct a complete projection from the event log alone.
 *
 * `cwd` is `null` by construction (a local binding, never in the log). The
 * seq/version bookkeeping (`version`, `nextSeq`, `lastAppliedSeq`) is the
 * write-path's, not the reducer's — the import path sets it from the actual
 * event seqs. `title` is not in the log (the summariser writes it out-of-band),
 * so it derives to `null`; the UI falls back to the workflow name.
 */
// contract: no-bump — comment-only edit (routing.input removal); the fold reads
// no new field and the contract-surface hash is unchanged.
export function genesisToInitialState(runId: string, payload: RunEnqueuedPayload, ts: number): RunState {
  return {
    runId,
    version: 0,
    status: "queued",
    currentNode: null,
    workflowSha: payload.workflowSha,
    contractVersion: payload.contractVersion,
    routing: payload.routing,
    metrics: emptyMetrics(),
    nextSeq: 0,
    lastAppliedSeq: 0,
    priority: payload.priority ?? 0,
    enqueuedAt: ts,
    readyAt: ts,
    nodeStartedAt: null,
    dispatchStartedAt: null,
    updatedAt: ts,
    title: null,
    baseGitSha: null,
    baseGitRef: null,
    finalGitSha: null,
    finalHeadRef: null,
    diffBaseSha: null,
    changeStat: null,
    inboxStatus: null,
    acceptedSha: null,
    cwd: null,
    projectId: payload.projectId,
    projectName: payload.projectName,
    workflowName: payload.workflowName ?? null,
    workflowScope: payload.workflowScope ?? null,
    workflowPath: payload.workflowPath ?? null,
    scheduleId: payload.scheduleId ?? null,
  };
}

/**
 * Reconstruct a complete `run_state` from a run's raw event log — the import /
 * `show` derivation. Seeds from the genesis `intent.run_enqueued`, then applies
 * each fact at its recorded ts (exactly as `appendFact` did), so timestamps and
 * `activeMs` match the original. Non-fact events (observability) are skipped.
 * Seq/version bookkeeping is set from the log's seqs (`nextSeq` leads every
 * carried seq, so a later `bumpRunSeq` can't collide).
 */
export function deriveRunState(
  runId: string,
  events: readonly { seq: number; type: string; payload: unknown; ts: number }[],
): RunState {
  const genesis = events.find((e) => e.type === "intent.run_enqueued");
  if (genesis == null) throw new Error(`deriveRunState: no genesis (intent.run_enqueued) event for ${runId}`);
  let state = genesisToInitialState(runId, genesis.payload as RunEnqueuedPayload, genesis.ts);
  let maxSeq = -1;
  let lastFactSeq = 0;
  for (const e of events) {
    if (e.seq > maxSeq) maxSeq = e.seq;
    if (e.type === "intent.run_enqueued" || !e.type.startsWith("fact.")) continue;
    state = applyFact(state, { type: e.type, payload: e.payload } as FactEvent, e.ts);
    if (e.seq > lastFactSeq) lastFactSeq = e.seq;
  }
  return { ...state, version: lastFactSeq, nextSeq: maxSeq + 1, lastAppliedSeq: lastFactSeq };
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
    totalCacheReadCostUsd: m.totalCacheReadCostUsd ?? 0,
    totalCacheWriteCostUsd: m.totalCacheWriteCostUsd ?? 0,
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
