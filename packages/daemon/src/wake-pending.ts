// Wake non-dispatching runs that have actionable pending intents.
//
// `paused`, `paused_hitl`, and `quarantined` runs are skipped by the
// executor's dispatch loop, so the normal fold never runs for them.
// Without this sweep four operator intents would be silently lost:
//
//   - `intent.cancel_requested` on any paused or quarantined run:
//     the run sits forever even though the operator asked to kill it.
//   - `intent.hitl_input` on `paused_hitl` runs: the run never wakes
//     to deliver the answer.
//   - `intent.resume` on `paused` (any reason) or `paused_hitl` runs:
//     the operator asked to retry the dispatch but no fact transitions
//     the run back to `queued`.
//   - `intent.unquarantine { resolution }` on quarantined runs:
//     persisted by the server (`POST /runs/:id/unquarantine`) but no
//     daemon code consumes it.
//
// The cancel and unquarantine gaps surfaced while writing
// `docs/intent-fold.md` for top.md #3.
//
// `wakePending` runs at the top of the executor loop. The internal
// order is load-bearing: cancel runs first so a run with BOTH a cancel
// intent and an unquarantine / hitl_input ends up cancelled (fold rule
// R1: cancel beats everything).

import { ConcurrencyError, type FactEvent, type IEventStore, type OrphanSideEffectRow } from "@swarm/store";

export interface WakePendingResult {
  cancelled: string[];
  hitlWoken: string[];
  resumed: string[];
  retryResumed: string[];
  unquarantined: string[];
  /** Parent run ids transitioned out of `running_children` because every
   *  sub-run reached terminal. P2.3 of `docs/proposals/parallel.md`. */
  fanoutConverged: string[];
}

/**
 * Drive every actionable pending intent on a non-dispatching run to a
 * terminal or queued state. Idempotent — safe to call on every executor
 * tick.
 */
export function wakePending(store: IEventStore, now: () => number = Date.now): WakePendingResult {
  const cancelled = wakeCancel(store);
  const hitlWoken = wakeHitl(store);
  const resumed = wakeResume(store);
  const retryResumed = wakeAutoResume(store, now);
  const unquarantined = wakeUnquarantine(store);
  // first_success cancellation runs BEFORE the fanout-convergence sweep so
  // the cascading cancel intents have a chance to be observed by
  // `wakeCancel`-style flows on the same tick (children that are
  // paused/paused_hitl pick the cancel up immediately; running children
  // pick it up via their own dispatchOne fold). The convergence sweep
  // still only fires when every child is terminal — the cancel signals
  // here just bring the laggards there faster.
  wakeFirstSuccess(store);
  const fanoutConverged = wakeRunningChildren(store);
  return { cancelled, hitlWoken, resumed, retryResumed, unquarantined, fanoutConverged };
}

/**
 * Cancel any paused_* / quarantined / running_children run with an
 * unapplied `intent.cancel_requested`. Emits `fact.run_cancelled
 * { intentSeq }`. Cascades to active children for `running_children`
 * parents — without that, the parent's cancel intent sits unapplied
 * because no executor dispatch ever picks up a parent in that state.
 */
function wakeCancel(store: IEventStore): string[] {
  const out: string[] = [];
  const candidates = store.getWakeCandidates({
    // `queued` covers sub-runs whose parent already cancelled (parent
    // is no longer `running_children` so the claim picker can't see
    // them — they'd sit queued forever otherwise). `running_children`
    // covers parents themselves whose cancel intent was appended
    // while their handler had already exited at fact.fanout_started.
    statuses: ["paused", "paused_hitl", "paused_auto", "quarantined", "running_children", "queued"],
  });
  for (const row of candidates) {
    const cancel = store.getNextPendingIntent(row.runId, "intent.cancel_requested", row.lastAppliedSeq);
    if (cancel == null) continue;
    try {
      // For running_children parents, cascade the cancel to every
      // active child BEFORE marking the parent cancelled so the
      // children pick it up on the next wake. The parent's own
      // fact.run_cancelled lands in the same call; children
      // transition independently via their own wakeCancel pass.
      if (row.status === "running_children") {
        for (const childId of store.activeChildRuns(row.runId)) {
          store.appendIntent(childId, {
            type: "intent.cancel_requested",
            payload: { reason: "parent_cancelled" },
          });
        }
      }
      store.appendFact(row.runId, [{ type: "fact.run_cancelled", payload: { intentSeq: cancel.seq } }], row.version, {
        advanceAppliedTo: cancel.seq,
      });
      out.push(row.runId);
    } catch (err) {
      if (!(err instanceof ConcurrencyError)) throw err;
    }
  }
  return out;
}

/**
 * Wake paused_hitl runs that have a pending `intent.hitl_input`.
 * Emits `fact.run_resumed`. The intent is left UNAPPLIED — the next
 * dispatch's fold consumes it as `decision.hitlInput`. lastAppliedSeq
 * stays put so the fold sees the intent.
 */
function wakeHitl(store: IEventStore): string[] {
  const out: string[] = [];
  const candidates = store.getWakeCandidates({ statuses: ["paused_hitl"] });
  for (const row of candidates) {
    const hasHitl = store.getNextPendingIntent(row.runId, "intent.hitl_input", row.lastAppliedSeq);
    if (hasHitl == null) continue;
    try {
      store.appendFact(
        row.runId,
        [
          {
            type: "fact.run_resumed",
            payload: { fromStatus: "paused_hitl", inputIntentSeq: hasHitl.seq },
          },
        ],
        row.version,
      );
      out.push(row.runId);
    } catch (err) {
      if (!(err instanceof ConcurrencyError)) throw err;
    }
  }
  return out;
}

/**
 * Wake any paused_* run that has an unapplied `intent.resume`. Emits
 * `fact.run_resumed { fromStatus, inputIntentSeq }`. Generic counterpart
 * to `intent.hitl_input` — operators use this when there's no payload to
 * deliver (the canonical case is short-circuiting an auto-wake timer or
 * resuming after a provider transport error). Quarantined runs are NOT
 * swept here; they require the typed `intent.unquarantine { resolution }`
 * because the operator has to pick one of treat_as_done / retry / cancel.
 */
function wakeResume(store: IEventStore): string[] {
  const out: string[] = [];
  const candidates = store.getWakeCandidates({
    statuses: ["paused", "paused_hitl", "paused_auto"],
  });
  for (const row of candidates) {
    const intent = store.getNextPendingIntent(row.runId, "intent.resume", row.lastAppliedSeq);
    if (intent == null) continue;
    try {
      // Don't advance lastAppliedSeq here. The fold on the next
      // dispatch consumes `intent.resume` as a no-op (it's a wake
      // marker; the wake fact already transitions status), but
      // crucially it ALSO consumes any EARLIER unapplied intents
      // queued before this resume — e.g. an `intent.budget_adjusted`
      // that should write `budget_override.<scope>.<metric>` into
      // routing. If we advance applied seq past `intent.resume.seq`
      // here, those earlier intents get silently marked applied
      // WITHOUT the fold processing their routing deltas; the
      // dispatch reads stale caps and re-pauses immediately,
      // producing the production "Raise & Resume re-pauses" loop.
      // The fold's `applied` includes this resume seq too, so the
      // post-handler commit advances naturally; no refire.
      store.appendFact(
        row.runId,
        [
          {
            type: "fact.run_resumed",
            payload: {
              fromStatus: row.status as never,
              inputIntentSeq: intent.seq,
            },
          },
        ],
        row.version,
      );
      out.push(row.runId);
    } catch (err) {
      if (!(err instanceof ConcurrencyError)) throw err;
    }
  }
  return out;
}

/**
 * Wake any auto-resumable paused state whose timer has elapsed.
 * `paused_auto` covers both the engine retry-policy backoff
 * (`reason:"handler_retry"`) and the provider transport-error
 * auto-retry (`reason:"provider_retry"`). Both write
 * `routing.internal.auto_resume_at` (ms epoch); once `now()` catches
 * up we emit `fact.run_resumed { fromStatus: "paused_auto" }` and the
 * run goes back to queued for re-claim. The same node re-dispatches
 * because either `fact.node_completed` already pointed nextNode at
 * the retrying node (handler_retry) or the executor still has the
 * run on its current node (provider_retry). Manual-only pause states
 * (`paused`, `paused_hitl`) ignore this routing key — they wake on
 * `intent.resume` only.
 */
function wakeAutoResume(store: IEventStore, now: () => number): string[] {
  const out: string[] = [];
  const candidates = store.getWakeCandidates({
    statuses: ["paused_auto"],
    autoResumeBefore: now(),
  });
  for (const row of candidates) {
    try {
      store.appendFact(
        row.runId,
        [
          {
            type: "fact.run_resumed",
            payload: { fromStatus: "paused_auto" },
          },
        ],
        row.version,
      );
      out.push(row.runId);
    } catch (err) {
      if (!(err instanceof ConcurrencyError)) throw err;
    }
  }
  return out;
}

/**
 * Drive `intent.unquarantine` resolutions on quarantined runs.
 *
 *   - `cancel`         → `fact.run_cancelled`
 *   - `retry`          → `fact.run_resumed` (run goes back to queued; the
 *                        handler re-dispatches at the same iteration; the
 *                        provider dedups via the stable idempotencyKey)
 *   - `treat_as_done`  → synthesize a `fact.side_effect_done` for each
 *                        orphan + `fact.run_resumed`. The synthetic dones
 *                        match the orphans on `idempotencyKey`, so the
 *                        startup-sweep no longer flags them on subsequent
 *                        restarts. For providers without idempotency
 *                        support this is the operator's only safe escape
 *                        hatch — they assert the call already succeeded.
 *
 * Unknown / malformed resolutions are skipped (no fact emitted) so the
 * operator can re-issue with a valid one.
 */
function wakeUnquarantine(store: IEventStore): string[] {
  const out: string[] = [];
  const candidates = store.getWakeCandidates({ statuses: ["quarantined"] });
  for (const row of candidates) {
    const intent = store.getNextPendingIntent(row.runId, "intent.unquarantine", row.lastAppliedSeq);
    if (intent == null) continue;

    const payload = intent.payload as { resolution?: string } | null;
    const resolution = payload?.resolution;
    if (resolution !== "cancel" && resolution !== "retry" && resolution !== "treat_as_done") {
      continue;
    }

    const facts: FactEvent[] = [];
    if (resolution === "cancel") {
      facts.push({ type: "fact.run_cancelled", payload: { intentSeq: intent.seq } });
    } else {
      if (resolution === "treat_as_done") {
        facts.push(...synthesisedDoneFacts(store.findOrphanSideEffects(row.runId)));
      }
      facts.push({
        type: "fact.run_resumed",
        payload: { fromStatus: "quarantined", inputIntentSeq: intent.seq },
      });
    }

    try {
      store.appendFact(row.runId, facts, row.version, { advanceAppliedTo: intent.seq });
      out.push(row.runId);
    } catch (err) {
      if (!(err instanceof ConcurrencyError)) throw err;
    }
  }
  return out;
}

function synthesisedDoneFacts(orphans: OrphanSideEffectRow[]): FactEvent[] {
  return orphans.map((o) => ({
    type: "fact.side_effect_done",
    payload: {
      idempotencyKey: o.idempotencyKey,
      artifactKey: `__synth_treat_as_done__:${o.nodeId ?? ""}:${o.toolName ?? ""}`,
    },
  }));
}

/**
 * Promote parent runs out of `running_children` once every sub-run has
 * reached a terminal status. P2.3 of `docs/proposals/parallel.md`.
 *
 * For each parent in `running_children` with zero active children:
 *   1. Resolve `(parentNodeId, fanInNode, subRunIds)` from routing.
 *   2. Read each sub-run's projection — final status, cost rollup,
 *      billed-tokens rollup.
 *   3. Emit one `fact.subrun_completed` per sub-run (reducer folds cost
 *      into the parent's projection, preserving D3's rollup invariant).
 *   4. Emit one `fact.fanout_completed` carrying the inline outcomes
 *      (reducer transitions parent to `queued`, sets `readyAt = now`).
 *
 * Both facts land in the same OCC commit so a half-converged state is
 * unobservable. Late-arriving sub-runs (a paused sub-run that wakes and
 * terminates AFTER this sweep already converged the parent) can never
 * happen by construction: the sweep only fires when
 * `activeChildRuns(parent) === []`, which already excludes paused
 * statuses (they're non-terminal).
 *
 * Sub-runs whose final status is `paused`, `paused_hitl`, `paused_auto`,
 * or `quarantined` are NOT terminal and the helper keeps waiting (the
 * proposal's D8 / D9 — sub-run quarantine / pause blocks the parent
 * without cascading).
 */
function wakeRunningChildren(store: IEventStore): string[] {
  const out: string[] = [];
  const candidates = store.getWakeCandidates({ statuses: ["running_children"] });
  for (const row of candidates) {
    const active = store.activeChildRuns(row.runId);
    if (active.length > 0) continue;

    const parentState = store.getState(row.runId);
    if (parentState == null) continue;
    const parentNodeId = parentState.currentNode;
    if (parentNodeId == null) continue;

    const subRunIdsRaw = parentState.routing[`parallel.${parentNodeId}.sub_run_ids`];
    if (!Array.isArray(subRunIdsRaw)) continue;
    const subRunIds: string[] = [];
    for (const v of subRunIdsRaw) {
      if (typeof v !== "string") continue;
      subRunIds.push(v);
    }
    if (subRunIds.length === 0) continue;
    const fanInNode = parentState.routing[`parallel.${parentNodeId}.fan_in_node`];
    if (typeof fanInNode !== "string") continue;

    const outcomes: Array<{
      subRunId: string;
      parallelIndex: number;
      finalStatus: "completed" | "halted" | "cancelled";
      costUsd: number;
      billedTokens: number;
    }> = [];
    const facts: FactEvent[] = [];
    let allTerminal = true;
    for (let i = 0; i < subRunIds.length; i++) {
      const childId = subRunIds[i]!;
      const child = store.getState(childId);
      if (child == null) {
        // Sub-run vanished. The sweep treats it as a halted slot so the
        // parent doesn't wedge — fan_in surfaces the gap via routing.
        outcomes.push({ subRunId: childId, parallelIndex: i, finalStatus: "halted", costUsd: 0, billedTokens: 0 });
        facts.push({
          type: "fact.subrun_completed",
          payload: {
            subRunId: childId,
            parentNodeId,
            parallelIndex: i,
            finalStatus: "halted",
            costUsd: 0,
            billedTokens: 0,
          },
        });
        continue;
      }
      const final = mapTerminalStatus(child.status);
      if (final == null) {
        // Child is still non-terminal (paused / paused_hitl /
        // paused_auto). Don't converge yet.
        allTerminal = false;
        break;
      }
      const outcome = {
        subRunId: childId,
        parallelIndex: i,
        finalStatus: final,
        costUsd: child.metrics.totalCostUsd,
        billedTokens: child.metrics.billedTokens,
      };
      outcomes.push(outcome);
      // Forward the child's full token split into the parent's
      // metrics so the parent's UI shows correct input/output/cache
      // totals after rollup. Omit zero fields to keep the 4 KB
      // payload bound comfortable on wide fan-outs.
      const payload: {
        subRunId: string;
        parentNodeId: string;
        parallelIndex: number;
        finalStatus: "completed" | "halted" | "cancelled";
        costUsd: number;
        billedTokens: number;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        fanInScore?: number;
      } = {
        subRunId: childId,
        parentNodeId,
        parallelIndex: i,
        finalStatus: final,
        costUsd: child.metrics.totalCostUsd,
        billedTokens: child.metrics.billedTokens,
      };
      if (child.metrics.totalInputTokens > 0) payload.inputTokens = child.metrics.totalInputTokens;
      if (child.metrics.totalOutputTokens > 0) payload.outputTokens = child.metrics.totalOutputTokens;
      if (child.metrics.totalCacheReadTokens > 0) payload.cacheReadTokens = child.metrics.totalCacheReadTokens;
      if (child.metrics.totalCacheWriteTokens > 0) payload.cacheWriteTokens = child.metrics.totalCacheWriteTokens;
      const score = child.routing["score"];
      if (typeof score === "number" && Number.isFinite(score)) payload.fanInScore = score;
      facts.push({ type: "fact.subrun_completed", payload });
    }
    if (!allTerminal) continue;

    facts.push({
      type: "fact.fanout_completed",
      payload: {
        parentNodeId,
        fanInNode,
        outcomes,
      },
    });

    try {
      store.appendFact(row.runId, facts, row.version);
      out.push(row.runId);
    } catch (err) {
      if (!(err instanceof ConcurrencyError)) throw err;
    }
  }
  return out;
}

/**
 * `first_success` join-policy cancellation (P4 of
 * `docs/proposals/parallel.md`). When a parent run is in
 * `running_children` AND `join_policy === "first_success"` AND any
 * sub-run has reached `status="completed"`, append
 * `intent.cancel_requested { reason: "first_success_won" }` on every
 * remaining active sub-run. Standard cancel semantics: children unwind
 * (some emit `fact.run_cancelled` immediately; others abort their
 * in-flight handler first), and the wake-pending convergence sweep
 * promotes the parent once they're all terminal.
 *
 * Idempotent: re-appending a cancel intent on a sub-run that already
 * carries one is harmless — `intent.cancel_requested` is consumed at
 * most once by the fold (further appends are no-ops). Detection guards
 * against re-issuing the cancel on the same tick by checking whether a
 * pending cancel already exists on the sub-run's log.
 */
function wakeFirstSuccess(store: IEventStore): string[] {
  const out: string[] = [];
  const candidates = store.getWakeCandidates({ statuses: ["running_children"] });
  for (const row of candidates) {
    const state = store.getState(row.runId);
    if (state == null) continue;
    const parentNodeId = state.currentNode;
    if (parentNodeId == null) continue;
    const joinPolicy = state.routing[`parallel.${parentNodeId}.join_policy`];
    if (joinPolicy !== "first_success") continue;
    const childIds = state.routing[`parallel.${parentNodeId}.sub_run_ids`];
    if (!Array.isArray(childIds)) continue;

    // Find at least one child that completed (winner).
    let anyWinner = false;
    const childStates: { id: string; status: string }[] = [];
    for (const idRaw of childIds) {
      if (typeof idRaw !== "string") continue;
      const child = store.getState(idRaw);
      if (child == null) continue;
      childStates.push({ id: idRaw, status: child.status });
      if (child.status === "completed") anyWinner = true;
    }
    if (!anyWinner) continue;

    // Cascade cancels onto every non-terminal sibling.
    for (const c of childStates) {
      const terminal = c.status === "completed" || c.status === "cancelled" || c.status === "halted";
      if (terminal) continue;
      // Skip if a cancel intent is already pending and unapplied — no
      // need to flood the event log.
      const childState = store.getState(c.id);
      if (childState != null) {
        const pending = store.getNextPendingIntent(c.id, "intent.cancel_requested", childState.lastAppliedSeq);
        if (pending != null) continue;
      }
      try {
        store.appendIntent(c.id, {
          type: "intent.cancel_requested",
          payload: { reason: "first_success_won" },
        });
      } catch {
        // Best-effort — a child that vanished or whose store handle
        // rejected is harmless: convergence will sweep it next tick.
      }
    }
    out.push(row.runId);
  }
  return out;
}

function mapTerminalStatus(status: string): "completed" | "halted" | "cancelled" | null {
  if (status === "completed") return "completed";
  if (status === "halted") return "halted";
  if (status === "cancelled") return "cancelled";
  return null;
}
