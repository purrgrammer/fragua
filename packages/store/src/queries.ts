// Named SQL queries for the event store.
//
// Every prepared statement the store runs lives here as a constant string,
// with a typed function that takes the Database handle and returns shaped
// rows. Inlined SQL elsewhere is a smell — see `.agents/skills/backend`.
//
// Aggregations (sums, counts) belong in SQL; the project rule is to push
// numerical totals into queries instead of folding events in TypeScript,
// because folding silently drops events that fall outside whatever window
// the reducer happens to model.

import type { Database } from "bun:sqlite";

// ─────────────────────────────────────────────────────────────────────
// Step cost / token aggregates
// ─────────────────────────────────────────────────────────────────────

/**
 * One row per `llm.start` event for a run. Cost / token sums and the
 * final `llm.done` are computed over the window
 *   (this llm.start, next llm.start for the same nodeId)
 * which is the correct boundary for `cost.recorded` events that fire
 * AFTER `llm.done` (one llm.start opens the step; the agent emits
 * multiple message_end → cost.recorded inside it on tool-using turns).
 *
 * `endedAtMs` and `stopReason` come from the LAST `llm.done` in the
 * window — earlier ones close individual messages within the same
 * backend.run, not the step itself.
 */
export interface StepAggregateRow {
  startSeq: number;
  startTs: number;
  nodeId: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  billedTokens: number;
  costEventCount: number;
  endedAtMs: number | null;
  stopReason: string | null;
}

const STEP_AGGREGATES_SQL = `
  WITH starts AS (
    SELECT
      seq,
      ts,
      json_extract(payload, '$.nodeId') AS node_id,
      LEAD(seq) OVER (
        PARTITION BY json_extract(payload, '$.nodeId')
        ORDER BY seq
      ) AS next_seq
    FROM events
    WHERE run_id = ?1 AND type = 'llm.start'
  )
  SELECT
    s.seq                                                                         AS startSeq,
    s.ts                                                                          AS startTs,
    s.node_id                                                                     AS nodeId,
    COALESCE(SUM(CAST(json_extract(c.payload, '$.cost_usd')           AS REAL))   , 0) AS costUsd,
    COALESCE(SUM(CAST(json_extract(c.payload, '$.input_tokens')       AS INTEGER)), 0) AS inputTokens,
    COALESCE(SUM(CAST(json_extract(c.payload, '$.output_tokens')      AS INTEGER)), 0) AS outputTokens,
    COALESCE(SUM(CAST(json_extract(c.payload, '$.cache_read_tokens')  AS INTEGER)), 0) AS cacheReadTokens,
    COALESCE(SUM(CAST(json_extract(c.payload, '$.cache_write_tokens') AS INTEGER)), 0) AS cacheWriteTokens,
    COALESCE(SUM(CAST(json_extract(c.payload, '$.total_tokens')       AS INTEGER)), 0) AS billedTokens,
    COUNT(c.seq)                                                                  AS costEventCount,
    (
      SELECT MAX(d.ts) FROM events d
      WHERE d.run_id = ?1
        AND d.type   = 'llm.done'
        AND json_extract(d.payload, '$.nodeId') = s.node_id
        AND d.seq    > s.seq
        AND (s.next_seq IS NULL OR d.seq < s.next_seq)
    )                                                                             AS endedAtMs,
    (
      SELECT json_extract(d.payload, '$.stop_reason') FROM events d
      WHERE d.run_id = ?1
        AND d.type   = 'llm.done'
        AND json_extract(d.payload, '$.nodeId') = s.node_id
        AND d.seq    > s.seq
        AND (s.next_seq IS NULL OR d.seq < s.next_seq)
      ORDER BY d.seq DESC
      LIMIT 1
    )                                                                             AS stopReason
  FROM starts s
  LEFT JOIN events c
    ON c.run_id = ?1
   AND c.type   = 'cost.recorded'
   AND json_extract(c.payload, '$.nodeId') = s.node_id
   AND c.seq    > s.seq
   AND (s.next_seq IS NULL OR c.seq < s.next_seq)
  GROUP BY s.seq, s.ts, s.node_id
  ORDER BY s.seq
`;

export function getStepAggregates(db: Database, runId: string): StepAggregateRow[] {
  return db
    .query<
      {
        startSeq: number;
        startTs: number;
        nodeId: string | null;
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        billedTokens: number;
        costEventCount: number;
        endedAtMs: number | null;
        stopReason: string | null;
      },
      [string]
    >(STEP_AGGREGATES_SQL)
    .all(runId);
}

// ─────────────────────────────────────────────────────────────────────
// Run cost totals (cross-check / diagnostics)
// ─────────────────────────────────────────────────────────────────────

/**
 * Sum of every `cost.recorded` event in a run, regardless of whether it
 * falls inside an `llm.start` window. Use this to cross-check that step
 * aggregates account for the full run total — anything left over comes
 * from synthetic-node events (summariser, title generator).
 */
export interface RunCostTotalsRow {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  billedTokens: number;
  eventCount: number;
}

const RUN_COST_TOTALS_SQL = `
  SELECT
    COALESCE(SUM(CAST(json_extract(payload, '$.cost_usd')           AS REAL))   , 0) AS costUsd,
    COALESCE(SUM(CAST(json_extract(payload, '$.input_tokens')       AS INTEGER)), 0) AS inputTokens,
    COALESCE(SUM(CAST(json_extract(payload, '$.output_tokens')      AS INTEGER)), 0) AS outputTokens,
    COALESCE(SUM(CAST(json_extract(payload, '$.cache_read_tokens')  AS INTEGER)), 0) AS cacheReadTokens,
    COALESCE(SUM(CAST(json_extract(payload, '$.cache_write_tokens') AS INTEGER)), 0) AS cacheWriteTokens,
    COALESCE(SUM(CAST(json_extract(payload, '$.total_tokens')       AS INTEGER)), 0) AS billedTokens,
    COUNT(*)                                                                         AS eventCount
  FROM events
  WHERE run_id = ?1 AND type = 'cost.recorded'
`;

export function getRunCostTotals(db: Database, runId: string): RunCostTotalsRow {
  const row = db.query<RunCostTotalsRow, [string]>(RUN_COST_TOTALS_SQL).get(runId);
  return (
    row ?? {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      billedTokens: 0,
      eventCount: 0,
    }
  );
}

// ─────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────

/**
 * Full-shape row from the messages table — `run_id`, `ordinal`,
 * `content` (serialized AgentMessage), `node_id`, `iteration`. Returned
 * by `selectMessages` for the in-process consumers (write-queue
 * deduplication, thread rehydration) that need every column.
 */
export interface MessageRow {
  run_id: string;
  ordinal: number;
  content: string;
  node_id: string | null;
  iteration: number;
}

/**
 * Wire-shape row for the `/runs/:id/messages` HTTP endpoint — only the
 * columns the web transcript consumes. `run_id` is always equal to the
 * URL/path scope (redundant) and `iteration` is unused by the UI;
 * skipping both at the SQL layer keeps SQLite from materialising them
 * into the row buffer at all.
 */
export interface NarrowMessageRow {
  ordinal: number;
  content: string;
  node_id: string | null;
}

const SELECT_MESSAGES_BY_RUN_SQL = `
  SELECT run_id, ordinal, content, node_id, iteration
    FROM messages
   WHERE run_id = ?1 AND ordinal > ?2
   ORDER BY ordinal ASC
   LIMIT ?3
`;

const SELECT_MESSAGES_BY_RUN_NODE_SQL = `
  SELECT run_id, ordinal, content, node_id, iteration
    FROM messages
   WHERE run_id = ?1 AND ordinal > ?2 AND node_id = ?3
   ORDER BY ordinal ASC
   LIMIT ?4
`;

const SELECT_MESSAGES_NARROW_BY_RUN_SQL = `
  SELECT ordinal, content, node_id
    FROM messages
   WHERE run_id = ?1 AND ordinal > ?2
   ORDER BY ordinal ASC
   LIMIT ?3
`;

const SELECT_MESSAGES_NARROW_BY_RUN_NODE_SQL = `
  SELECT ordinal, content, node_id
    FROM messages
   WHERE run_id = ?1 AND ordinal > ?2 AND node_id = ?3
   ORDER BY ordinal ASC
   LIMIT ?4
`;

/** SQLite treats `LIMIT -1` as unbounded — used when the caller passes
 * `limit: undefined`. The transcript view shows the full list. */
const NO_LIMIT = -1;

// ─────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────

/** Raw events row — unparsed `payload` JSON. The store maps this into
 * `StoredEvent` after parsing. Defined here so the SQL projection lives
 * next to the helper that runs it. */
export interface EventRow {
  run_id: string;
  seq: number;
  type: string;
  writer: string;
  payload: string;
  ts: number;
}

const SELECT_EVENTS_SQL = `
  SELECT run_id, seq, type, writer, payload, ts
    FROM events
   WHERE run_id = ?1 AND seq > ?2
   ORDER BY seq ASC
   LIMIT ?3
`;

export function selectEvents(db: Database, runId: string, opts: { sinceSeq: number; limit?: number }): EventRow[] {
  const limit = opts.limit ?? NO_LIMIT;
  return db.query<EventRow, [string, number, number]>(SELECT_EVENTS_SQL).all(runId, opts.sinceSeq, limit);
}

// `type IN (SELECT value FROM json_each(?))` lets a single bound
// parameter carry an arbitrary-sized kind list — keeps the SQL static
// (no dynamic placeholder building) and the parameter list fixed-arity.
// Both global-events queries below use the same trick.

// Why `ts >= ?` (not `ts > ?`) and `run_id ASC, seq ASC` tie-breakers:
//
// `seq` is per-run, so a single-int cursor doesn't carry a global
// order. The natural triple `(ts, run_id, seq)` has a subtle bug
// under strict-greater: a same-ms append to a `run_id` that
// lexicographically sorts *before* the cursor's `run_id` is filtered
// out — its tuple is "less than" the cursor even though it's a brand-
// new row the client hasn't seen. Strictly-greater on a tuple where
// `ts` ties on milliseconds drops events.
//
// `ts >= ?` keeps the new event in. The cost is bounded redelivery of
// rows at exactly `cursor.ts`, which the route layer dedupes via a
// per-connection Set keyed on `(runId, seq)`. The SSE `id:` carries the
// full triple so the client can re-dedupe across reconnects.
const SELECT_GLOBAL_EVENTS_AFTER_SQL = `
  SELECT run_id, seq, type, writer, payload, ts
    FROM events
   WHERE ts >= ?1
     AND type IN (SELECT value FROM json_each(?2))
   ORDER BY ts ASC, run_id ASC, seq ASC
   LIMIT ?3
`;

// Backfill: take the most-recent N events DESC inside a subquery, then
// re-sort ASC outside it so the caller gets oldest-first in a single
// round-trip. Without the wrapping ORDER BY, the route layer would have
// to .reverse() the array — at which point the "natural order" of the
// query stops matching what the API contract returns. This keeps the
// SQL the source of truth for ordering.
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

/**
 * Cross-run, ascending scan of events with `ts >= fromTs`, filtered by
 * `kindIn`. Used by the global SSE feed (`/events/stream`). Returns up
 * to `limit` rows ordered by `(ts, run_id, seq)` for stable iteration.
 *
 * The `>=` semantics are deliberate — see the SQL constant above for
 * why strict-greater on `(ts, run_id, seq)` would silently drop same-ms
 * appends. The route layer dedupes the bounded redelivery at
 * `cursor.ts` with a per-connection Set; the client re-dedupes across
 * reconnects via `(runId, seq)` identity.
 *
 * `kindIn` is required: the global feed always allow-lists. To list every
 * kind without filtering, pass `FEED_EVENT_KINDS` (the operator-relevant
 * union exported from `@swarm/store`).
 *
 * The `idx_events_ts(ts, run_id, seq)` index lets SQLite walk this
 * query without a sort step; the `type IN (json_each(?))` filter is
 * applied as a predicate on the indexed walk.
 */
export function selectGlobalEventsAfter(
  db: Database,
  opts: { fromTs: number; kindIn: readonly string[]; limit: number },
): EventRow[] {
  const kindsJson = JSON.stringify(opts.kindIn);
  return db
    .query<EventRow, [number, string, number]>(SELECT_GLOBAL_EVENTS_AFTER_SQL)
    .all(opts.fromTs, kindsJson, opts.limit);
}

/**
 * The most-recent `limit` events allow-listed by `kindIn`, returned
 * oldest-first. Used by the backfill route (`GET /events`) so Home shows
 * the last N relevant events on first paint. The DESC+LIMIT happens in
 * a subquery; the outer ORDER BY ASC reshapes the result so the API
 * contract ("chronological") matches the SQL — no client-side reverse.
 */
export function selectGlobalEventsLatest(db: Database, opts: { kindIn: readonly string[]; limit: number }): EventRow[] {
  const kindsJson = JSON.stringify(opts.kindIn);
  return db.query<EventRow, [string, number]>(SELECT_GLOBAL_EVENTS_LATEST_SQL).all(kindsJson, opts.limit);
}

export function selectMessages(
  db: Database,
  runId: string,
  opts: { sinceOrdinal: number; limit?: number; nodeId?: string },
): MessageRow[] {
  const limit = opts.limit ?? NO_LIMIT;
  if (opts.nodeId != null) {
    return db
      .query<MessageRow, [string, number, string, number]>(SELECT_MESSAGES_BY_RUN_NODE_SQL)
      .all(runId, opts.sinceOrdinal, opts.nodeId, limit);
  }
  return db
    .query<MessageRow, [string, number, number]>(SELECT_MESSAGES_BY_RUN_SQL)
    .all(runId, opts.sinceOrdinal, limit);
}

export function selectMessagesNarrow(
  db: Database,
  runId: string,
  opts: { sinceOrdinal: number; limit?: number; nodeId?: string },
): NarrowMessageRow[] {
  const limit = opts.limit ?? NO_LIMIT;
  if (opts.nodeId != null) {
    return db
      .query<NarrowMessageRow, [string, number, string, number]>(SELECT_MESSAGES_NARROW_BY_RUN_NODE_SQL)
      .all(runId, opts.sinceOrdinal, opts.nodeId, limit);
  }
  return db
    .query<NarrowMessageRow, [string, number, number]>(SELECT_MESSAGES_NARROW_BY_RUN_SQL)
    .all(runId, opts.sinceOrdinal, limit);
}
