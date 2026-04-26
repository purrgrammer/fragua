// Wake non-dispatching runs that have actionable pending intents.
//
// `paused_hitl`, `paused_provider_error`, and `quarantined` runs are
// skipped by the executor's dispatch loop, so the normal fold never
// runs for them. Without this sweep four operator intents would be
// silently lost:
//
//   - `intent.cancel_requested` on any paused or quarantined run:
//     the run sits forever even though the operator asked to kill it.
//   - `intent.hitl_input` on `paused_hitl` runs: the run never wakes
//     to deliver the answer.
//   - `intent.resume` on `paused_provider_error` (or `paused_hitl`)
//     runs: the operator asked to retry the dispatch but no fact
//     transitions the run back to `queued`.
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

import type { Database } from "bun:sqlite";
import { ConcurrencyError, type FactEvent, type IEventStore } from "@swarm/store";

type DbRow = { run_id: string; version: number; last_applied_seq: number };

export interface WakePendingResult {
  cancelled: string[];
  hitlWoken: string[];
  resumed: string[];
  unquarantined: string[];
}

/**
 * Drive every actionable pending intent on a non-dispatching run to a
 * terminal or queued state. Idempotent — safe to call on every executor
 * tick.
 */
export function wakePending(store: IEventStore): WakePendingResult {
  const cancelled = wakeCancel(store);
  const hitlWoken = wakeHitl(store);
  const resumed = wakeResume(store);
  const unquarantined = wakeUnquarantine(store);
  return { cancelled, hitlWoken, resumed, unquarantined };
}

/**
 * Cancel any paused_* / quarantined run with an unapplied
 * `intent.cancel_requested`. Emits `fact.run_cancelled { intentSeq }`.
 */
function wakeCancel(store: IEventStore): string[] {
  const out: string[] = [];
  const db = dbOf(store);
  if (db == null) return [];

  const rows = db
    .query<DbRow, []>(
      `SELECT run_id, version, last_applied_seq
         FROM run_state
        WHERE status IN ('paused_hitl', 'paused_provider_error', 'quarantined')`,
    )
    .all();

  for (const row of rows) {
    const cancel = db
      .query<{ seq: number }, [string, number]>(
        `SELECT seq FROM events
          WHERE run_id = ? AND seq > ? AND type = 'intent.cancel_requested'
          ORDER BY seq ASC
          LIMIT 1`,
      )
      .get(row.run_id, row.last_applied_seq);
    if (cancel == null) continue;

    try {
      store.appendFact(row.run_id, [{ type: "fact.run_cancelled", payload: { intentSeq: cancel.seq } }], row.version, {
        advanceAppliedTo: cancel.seq,
      });
      out.push(row.run_id);
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
  const db = dbOf(store);
  if (db == null) return [];

  const rows = db
    .query<DbRow, []>(
      `SELECT run_id, version, last_applied_seq
         FROM run_state WHERE status = 'paused_hitl'`,
    )
    .all();

  for (const row of rows) {
    const hasHitl = db
      .query<{ seq: number }, [string, number]>(
        `SELECT seq FROM events
          WHERE run_id = ? AND seq > ? AND type = 'intent.hitl_input'
          LIMIT 1`,
      )
      .get(row.run_id, row.last_applied_seq);
    if (hasHitl == null) continue;

    try {
      store.appendFact(
        row.run_id,
        [
          {
            type: "fact.run_resumed",
            payload: { fromStatus: "paused_hitl", inputIntentSeq: hasHitl.seq },
          },
        ],
        row.version,
      );
      out.push(row.run_id);
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
 * deliver (the canonical case is resuming after a provider transport
 * error). Quarantined runs are NOT swept here; they require the typed
 * `intent.unquarantine { resolution }` because the operator has to pick
 * one of treat_as_done / retry / cancel.
 */
function wakeResume(store: IEventStore): string[] {
  const out: string[] = [];
  const db = dbOf(store);
  if (db == null) return [];

  const rows = db
    .query<DbRow & { status: string }, []>(
      `SELECT run_id, version, last_applied_seq, status
         FROM run_state
        WHERE status IN ('paused_hitl', 'paused_provider_error')`,
    )
    .all();

  for (const row of rows) {
    const intent = db
      .query<{ seq: number }, [string, number]>(
        `SELECT seq FROM events
          WHERE run_id = ? AND seq > ? AND type = 'intent.resume'
          ORDER BY seq ASC
          LIMIT 1`,
      )
      .get(row.run_id, row.last_applied_seq);
    if (intent == null) continue;

    try {
      store.appendFact(
        row.run_id,
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
      out.push(row.run_id);
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
  const db = dbOf(store);
  if (db == null) return [];

  const rows = db
    .query<DbRow, []>(
      `SELECT run_id, version, last_applied_seq
         FROM run_state WHERE status = 'quarantined'`,
    )
    .all();

  for (const row of rows) {
    const intent = db
      .query<{ seq: number; payload: string }, [string, number]>(
        `SELECT seq, payload FROM events
          WHERE run_id = ? AND seq > ? AND type = 'intent.unquarantine'
          ORDER BY seq ASC
          LIMIT 1`,
      )
      .get(row.run_id, row.last_applied_seq);
    if (intent == null) continue;

    let payload: { resolution?: string };
    try {
      payload = JSON.parse(intent.payload) as { resolution?: string };
    } catch {
      continue;
    }
    const resolution = payload.resolution;
    if (resolution !== "cancel" && resolution !== "retry" && resolution !== "treat_as_done") {
      continue;
    }

    const facts: FactEvent[] = [];
    if (resolution === "cancel") {
      facts.push({ type: "fact.run_cancelled", payload: { intentSeq: intent.seq } });
    } else {
      if (resolution === "treat_as_done") {
        facts.push(...synthesisedDoneFacts(db, row.run_id));
      }
      facts.push({
        type: "fact.run_resumed",
        payload: { fromStatus: "quarantined", inputIntentSeq: intent.seq },
      });
    }

    try {
      store.appendFact(row.run_id, facts, row.version, { advanceAppliedTo: intent.seq });
      out.push(row.run_id);
    } catch (err) {
      if (!(err instanceof ConcurrencyError)) throw err;
    }
  }
  return out;
}

/**
 * For every orphaned `fact.side_effect_intent` on `runId` (no matching
 * done/failed keyed by idempotencyKey), produce a synthetic
 * `fact.side_effect_done`. Same JOIN shape as `startupSweep` so the two
 * stay coherent.
 */
function synthesisedDoneFacts(db: Database, runId: string): FactEvent[] {
  const orphans = db
    .query<{ idempotency_key: string; tool_name: string; node_id: string }, [string]>(
      `SELECT json_extract(i.payload, '$.idempotencyKey') AS idempotency_key,
              json_extract(i.payload, '$.toolName')       AS tool_name,
              json_extract(i.payload, '$.nodeId')         AS node_id
         FROM events i
         LEFT JOIN events d
                ON d.run_id = i.run_id
               AND d.type IN ('fact.side_effect_done','fact.side_effect_failed')
               AND json_extract(d.payload, '$.idempotencyKey') =
                   json_extract(i.payload, '$.idempotencyKey')
        WHERE i.run_id = ?
          AND i.type = 'fact.side_effect_intent'
          AND d.seq IS NULL`,
    )
    .all(runId);

  return orphans.map((o) => ({
    type: "fact.side_effect_done",
    payload: {
      idempotencyKey: o.idempotency_key,
      artifactKey: `__synth_treat_as_done__:${o.node_id ?? ""}:${o.tool_name ?? ""}`,
    },
  }));
}

function dbOf(store: IEventStore): Database | null {
  const db = (store as unknown as { db?: Database }).db;
  return db ?? null;
}
