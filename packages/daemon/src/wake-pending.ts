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
  return { cancelled, hitlWoken, resumed, retryResumed, unquarantined };
}

/**
 * Cancel any paused_* / quarantined run with an unapplied
 * `intent.cancel_requested`. Emits `fact.run_cancelled { intentSeq }`.
 */
function wakeCancel(store: IEventStore): string[] {
  const out: string[] = [];
  const candidates = store.getWakeCandidates({
    statuses: ["paused", "paused_hitl", "paused_auto", "quarantined"],
  });
  for (const row of candidates) {
    const cancel = store.getNextPendingIntent(row.runId, "intent.cancel_requested", row.lastAppliedSeq);
    if (cancel == null) continue;
    try {
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
        { advanceAppliedTo: intent.seq },
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
