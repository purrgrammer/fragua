// SQL + typed helpers for the `events` table.
//
// Every statement against `events` lives here as a named constant with a
// thin function that takes a Database handle and returns shaped rows.
// Inlined SQL elsewhere is a smell — `.agents/skills/backend`. The
// `events` table is the central event log: facts (writer='daemon'),
// intents (writer='web'), and observability (writer='daemon', no OCC)
// all share the same physical table.

import type { Database } from "bun:sqlite";
import type { IntentType } from "@swarm/types";

// ─────────────────────────────────────────────────────────────────────
// Row types
// ─────────────────────────────────────────────────────────────────────

/** Raw events row — unparsed `payload` JSON. The store maps this into
 *  `StoredEvent` after parsing. Defined here so the SQL projection lives
 *  next to the helper that runs it. */
export interface EventRow {
  run_id: string;
  seq: number;
  type: string;
  writer: string;
  payload: string;
  ts: number;
}

/** A single unapplied intent of a given type for a run. `payload` is
 *  parsed JSON; callers narrow as needed. */
export interface PendingIntentRow {
  seq: number;
  payload: unknown;
}

/** Side-effect intent without a matching done/failed (orphan after a
 *  daemon crash). Same JOIN shape as the startup-sweep so the two stay
 *  coherent. */
export interface OrphanSideEffectRow {
  idempotencyKey: string;
  toolName: string;
  nodeId: string;
}

// ─────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────

const INSERT_EVENT_DAEMON_SQL = `
  INSERT INTO events (run_id, seq, type, writer, payload, ts)
  VALUES (?, ?, ?, 'daemon', ?, ?)
`;

const INSERT_EVENT_WEB_SQL = `
  INSERT INTO events (run_id, seq, type, writer, payload, ts)
  VALUES (?, ?, ?, 'web', ?, ?)
`;

const INSERT_EVENT_RUN_ENQUEUED_SQL = `
  INSERT INTO events (run_id, seq, type, writer, payload, ts)
  VALUES (?, ?, 'intent.run_enqueued', 'web', ?, ?)
`;

/** Append a fact / observability event (writer='daemon'). Called inside
 *  the appendFact / appendObservabilityEvents transactions; `payload`
 *  is the validated JSON string. */
export function insertEventDaemon(
  db: Database,
  runId: string,
  seq: number,
  type: string,
  payload: string,
  ts: number,
): void {
  db.query(INSERT_EVENT_DAEMON_SQL).run(runId, seq, type, payload, ts);
}

/** Append an intent event (writer='web'). */
export function insertEventWeb(
  db: Database,
  runId: string,
  seq: number,
  type: string,
  payload: string,
  ts: number,
): void {
  db.query(INSERT_EVENT_WEB_SQL).run(runId, seq, type, payload, ts);
}

/** Append the synthetic `intent.run_enqueued` event at run creation. */
export function insertEventRunEnqueued(db: Database, runId: string, seq: number, payload: string, ts: number): void {
  db.query(INSERT_EVENT_RUN_ENQUEUED_SQL).run(runId, seq, payload, ts);
}

// ─────────────────────────────────────────────────────────────────────
// Per-run reads (single-run scope)
// ─────────────────────────────────────────────────────────────────────

const SELECT_EVENTS_BY_RUN_SQL = `
  SELECT run_id, seq, type, writer, payload, ts
    FROM events
   WHERE run_id = ?1 AND seq > ?2
   ORDER BY seq ASC
   LIMIT ?3
`;

/** SQLite treats `LIMIT -1` as unbounded — used when the caller passes
 *  `limit: undefined`. */
const NO_LIMIT = -1;

export function selectEvents(db: Database, runId: string, opts: { sinceSeq: number; limit?: number }): EventRow[] {
  const limit = opts.limit ?? NO_LIMIT;
  return db.query<EventRow, [string, number, number]>(SELECT_EVENTS_BY_RUN_SQL).all(runId, opts.sinceSeq, limit);
}

const SELECT_LATEST_EVENTS_SQL = `
  SELECT run_id, seq, type, writer, payload, ts
    FROM events
   WHERE run_id = ?1
   ORDER BY seq DESC
   LIMIT ?2
`;

/** The last N events for `runId`, newest first. Bounded backwards walk
 *  for callers that need "what just happened" without paying for a full
 *  scan. The covering (run_id, seq) primary key makes this cheap even
 *  on long-lived runs. */
export function selectLatestEvents(db: Database, runId: string, limit: number): EventRow[] {
  return db.query<EventRow, [string, number]>(SELECT_LATEST_EVENTS_SQL).all(runId, limit);
}

const SELECT_EVENTS_BY_TYPE_SQL = `
  SELECT run_id, seq, type, writer, payload, ts
    FROM events
   WHERE run_id = ?1 AND type = ?2
   ORDER BY seq ASC
`;

const SELECT_SNAPSHOT_EVENTS_SQL = `
  SELECT run_id, seq, type, writer, payload, ts
    FROM events
   WHERE run_id = ?1
     AND type IN ('snapshot.captured','fact.snapshot_recorded')
   ORDER BY seq ASC
`;

/** Every event of `type` for `runId` in seq order. Cheap (covered by
 *  the `events(run_id, seq)` primary key with a type filter scan).
 *  Currently the only caller is `spawn-subagent.ts`, seeding the
 *  cumulative cost rollup on a resumed `subagent.end` from prior
 *  brackets carrying the same `subagent_id`. The result set is
 *  bounded by the per-(run, subagent_id) bracket count — typically 1
 *  pre-crash + 1 resumed bracket. */
export function selectEventsByType(db: Database, runId: string, type: string): EventRow[] {
  return db.query<EventRow, [string, string]>(SELECT_EVENTS_BY_TYPE_SQL).all(runId, type);
}

/** All worktree-snapshot events for `runId` in seq order: both the
 *  per-step / HITL `snapshot.captured` observability events and the
 *  terminal `fact.snapshot_recorded` fact. These are the two event
 *  types that make up the Diff scrubber feed. */
export function selectSnapshotEvents(db: Database, runId: string): EventRow[] {
  return db.query<EventRow, [string]>(SELECT_SNAPSHOT_EVENTS_SQL).all(runId);
}

const SELECT_EVENTS_UNAPPLIED_INTENTS_SQL = `
  SELECT run_id, seq, type, writer, payload, ts
    FROM events
   WHERE run_id = ? AND seq > ? AND writer = 'web'
   ORDER BY seq ASC
`;

export function selectUnappliedIntents(db: Database, runId: string, sinceSeq: number): EventRow[] {
  return db.query<EventRow, [string, number]>(SELECT_EVENTS_UNAPPLIED_INTENTS_SQL).all(runId, sinceSeq);
}

const SELECT_NEXT_PENDING_INTENT_SQL = `
  SELECT seq, payload
    FROM events
   WHERE run_id = ?1 AND seq > ?2 AND type = ?3
   ORDER BY seq ASC
   LIMIT 1
`;

/** Next intent of `type` strictly after `sinceSeq` for `runId`, or null. */
export function selectNextPendingIntent(
  db: Database,
  runId: string,
  type: IntentType,
  sinceSeq: number,
): PendingIntentRow | null {
  const row = db
    .query<{ seq: number; payload: string }, [string, number, IntentType]>(SELECT_NEXT_PENDING_INTENT_SQL)
    .get(runId, sinceSeq, type);
  if (row == null) return null;
  return { seq: row.seq, payload: JSON.parse(row.payload) };
}

const SELECT_FACT_SIDE_EFFECT_DONE_SQL = `
  SELECT seq, payload FROM events
   WHERE run_id = ? AND type = 'fact.side_effect_done'
     AND json_extract(payload, '$.idempotencyKey') = ?
   LIMIT 1
`;

const SELECT_FACT_SIDE_EFFECT_INTENT_SQL = `
  SELECT payload FROM events
   WHERE run_id = ? AND type = 'fact.side_effect_intent'
     AND json_extract(payload, '$.idempotencyKey') = ?
   LIMIT 1
`;

export function selectFactSideEffectDone(
  db: Database,
  runId: string,
  idempotencyKey: string,
): { seq: number; payload: string } | null {
  return (
    db
      .query<{ seq: number; payload: string }, [string, string]>(SELECT_FACT_SIDE_EFFECT_DONE_SQL)
      .get(runId, idempotencyKey) ?? null
  );
}

export function selectFactSideEffectIntent(
  db: Database,
  runId: string,
  idempotencyKey: string,
): { payload: string } | null {
  return (
    db.query<{ payload: string }, [string, string]>(SELECT_FACT_SIDE_EFFECT_INTENT_SQL).get(runId, idempotencyKey) ??
    null
  );
}

const SELECT_ORPHAN_SIDE_EFFECTS_SQL = `
  SELECT json_extract(i.payload, '$.idempotencyKey') AS idempotencyKey,
         json_extract(i.payload, '$.toolName')       AS toolName,
         json_extract(i.payload, '$.nodeId')         AS nodeId
    FROM events i
    LEFT JOIN events d
           ON d.run_id = i.run_id
          AND d.type IN ('fact.side_effect_done','fact.side_effect_failed')
          AND json_extract(d.payload, '$.idempotencyKey') =
              json_extract(i.payload, '$.idempotencyKey')
   WHERE i.run_id = ?
     AND i.type   = 'fact.side_effect_intent'
     AND d.seq IS NULL
`;

export function selectOrphanSideEffects(db: Database, runId: string): OrphanSideEffectRow[] {
  return db.query<OrphanSideEffectRow, [string]>(SELECT_ORPHAN_SIDE_EFFECTS_SQL).all(runId);
}

// ─────────────────────────────────────────────────────────────────────
// Global feed reads
// ─────────────────────────────────────────────────────────────────────
//
// Two-query design for the global SSE feed.
//
// `seq` is per-run, so a single-int cursor doesn't carry a global
// order. The natural triple `(ts, run_id, seq)` is the index key, but
// strict-greater on the triple has a hole at the boundary `ts`: a new
// INSERT whose `run_id` falls lex-between two already-emitted
// `run_id`s at the same `ts` is filtered out. The forward cursor has
// already advanced past it. Two queries on `idx_events_ts(ts, run_id,
// seq)`:
//
//   - FORWARD: strict-tuple `(ts, run_id, seq) > (floorTs, lastRunId,
//     lastSeq)`. Advances on every emission, so a same-ts batch
//     larger than `LIMIT N` paginates across iterations.
//
//   - BOUNDARY RESCAN: events at exactly `ts == floorTs` with
//     `(run_id, seq) > (afterRunId, afterSeq)`. The loop paginates
//     ASC from `("", -1)` and filters via a per-`floorTs` Set of
//     emitted `(runId, seq)` keys. Catches every event at `floorTs`
//     the forward cursor stepped past.
//
// `type IN (SELECT value FROM json_each(?))` lets a single bound
// parameter carry an arbitrary-sized kind list — keeps the SQL static
// (no dynamic placeholder building) and the parameter list fixed-arity.

const SELECT_GLOBAL_EVENTS_FORWARD_SQL = `
  SELECT run_id, seq, type, writer, payload, ts
    FROM events
   WHERE (ts, run_id, seq) > (?1, ?2, ?3)
     AND type IN (SELECT value FROM json_each(?4))
   ORDER BY ts ASC, run_id ASC, seq ASC
   LIMIT ?5
`;

const SELECT_GLOBAL_EVENTS_AT_FLOOR_SQL = `
  SELECT run_id, seq, type, writer, payload, ts
    FROM events
   WHERE ts = ?1
     AND (run_id, seq) > (?2, ?3)
     AND type IN (SELECT value FROM json_each(?4))
   ORDER BY run_id ASC, seq ASC
   LIMIT ?5
`;

// Backfill: take the most-recent N events DESC inside a subquery, then
// re-sort ASC outside it so the caller gets oldest-first in a single
// round-trip.
const SELECT_GLOBAL_EVENTS_LATEST_SQL = `
  SELECT * FROM (
    SELECT run_id, seq, type, writer, payload, ts
      FROM events
     WHERE type IN (SELECT value FROM json_each(?1))
     ORDER BY ts DESC, run_id DESC, seq DESC
     LIMIT ?2
  )
  ORDER BY ts ASC, run_id ASC, seq ASC
`;

export function selectGlobalEventsForward(
  db: Database,
  opts: {
    floorTs: number;
    lastRunId: string;
    lastSeq: number;
    kindIn: readonly string[];
    limit: number;
  },
): EventRow[] {
  const kindsJson = JSON.stringify(opts.kindIn);
  return db
    .query<EventRow, [number, string, number, string, number]>(SELECT_GLOBAL_EVENTS_FORWARD_SQL)
    .all(opts.floorTs, opts.lastRunId, opts.lastSeq, kindsJson, opts.limit);
}

export function selectGlobalEventsAtFloor(
  db: Database,
  opts: {
    floorTs: number;
    afterRunId: string;
    afterSeq: number;
    kindIn: readonly string[];
    limit: number;
  },
): EventRow[] {
  const kindsJson = JSON.stringify(opts.kindIn);
  return db
    .query<EventRow, [number, string, number, string, number]>(SELECT_GLOBAL_EVENTS_AT_FLOOR_SQL)
    .all(opts.floorTs, opts.afterRunId, opts.afterSeq, kindsJson, opts.limit);
}

export function selectGlobalEventsLatest(db: Database, opts: { kindIn: readonly string[]; limit: number }): EventRow[] {
  const kindsJson = JSON.stringify(opts.kindIn);
  return db.query<EventRow, [string, number]>(SELECT_GLOBAL_EVENTS_LATEST_SQL).all(kindsJson, opts.limit);
}
