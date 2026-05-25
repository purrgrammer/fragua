// SQL + typed helpers for the `messages` table and the cross-table
// thread-rehydration scan over `events` + `run_state`.
//
// The transcript view (web `/runs/:id/messages`) hits a narrower
// projection than the dedup / write-queue path needs — both shapes are
// declared here so the SQL projection stays the source of truth.

import type { Database } from "bun:sqlite";

// ─────────────────────────────────────────────────────────────────────
// Row types
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
 * columns the web transcript consumes. `run_id` is omitted (already
 * pinned by the URL). `iteration` is included so the transcript can
 * align looped-node sections to their per-iteration nodeState.
 */
export interface NarrowMessageRow {
  ordinal: number;
  content: string;
  node_id: string | null;
  iteration: number;
}

// ─────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────

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
  SELECT ordinal, content, node_id, iteration
    FROM messages
   WHERE run_id = ?1 AND ordinal > ?2
   ORDER BY ordinal ASC
   LIMIT ?3
`;

const SELECT_MESSAGES_NARROW_BY_RUN_NODE_SQL = `
  SELECT ordinal, content, node_id, iteration
    FROM messages
   WHERE run_id = ?1 AND ordinal > ?2 AND node_id = ?3
   ORDER BY ordinal ASC
   LIMIT ?4
`;

/** SQLite treats `LIMIT -1` as unbounded — used when the caller passes
 *  `limit: undefined`. The transcript view shows the full list. */
const NO_LIMIT = -1;

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

// ─────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────

const SELECT_MESSAGE_BY_DEDUP_SQL = `
  SELECT ordinal FROM messages
   WHERE run_id = ? AND node_id = ? AND iteration = ? AND content_hash = ?
   LIMIT 1
`;

/** Look up an existing message at `(run, node, iteration)` with the
 *  same `content_hash`. Used by `appendMessage`'s opt-in dedup path
 *  (replay-safe re-dispatches). */
export function selectMessageByDedup(
  db: Database,
  runId: string,
  nodeId: string,
  iteration: number,
  contentHash: string,
): { ordinal: number } | null {
  return (
    db
      .query<{ ordinal: number }, [string, string, number, string]>(SELECT_MESSAGE_BY_DEDUP_SQL)
      .get(runId, nodeId, iteration, contentHash) ?? null
  );
}

const SELECT_MESSAGE_MAX_ORDINAL_SQL = `
  SELECT MAX(ordinal) AS m FROM messages WHERE run_id = ?
`;

export function selectMaxMessageOrdinal(db: Database, runId: string): number {
  const row = db.query<{ m: number | null }, [string]>(SELECT_MESSAGE_MAX_ORDINAL_SQL).get(runId);
  return row?.m ?? 0;
}

const INSERT_MESSAGE_SQL = `
  INSERT INTO messages (run_id, ordinal, content, node_id, iteration, content_hash)
  VALUES (?, ?, ?, ?, ?, ?)
`;

export function insertMessage(
  db: Database,
  args: {
    runId: string;
    ordinal: number;
    content: string;
    nodeId: string | null;
    iteration: number;
    contentHash: string;
  },
): void {
  db.query(INSERT_MESSAGE_SQL).run(
    args.runId,
    args.ordinal,
    args.content,
    args.nodeId,
    args.iteration,
    args.contentHash,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Thread rehydration (cross-table — messages + events + run_state)
// ─────────────────────────────────────────────────────────────────────

const SELECT_THREADS_FROM_MESSAGES_SQL = `
  SELECT DISTINCT m.run_id AS run_id, m.node_id AS thread_id
    FROM messages m
    JOIN run_state r ON r.run_id = m.run_id
   WHERE m.node_id IS NOT NULL
     AND r.status IN ('queued','running','paused_human','paused')
`;

const SELECT_THREADS_FROM_EVENTS_SQL = `
  SELECT DISTINCT e.run_id AS run_id,
                  CAST(json_extract(e.payload, '$.thread_id') AS TEXT) AS thread_id
    FROM events e
    JOIN run_state r ON r.run_id = e.run_id
   WHERE e.type = 'llm.start'
     AND json_extract(e.payload, '$.thread_id') IS NOT NULL
     AND r.status IN ('queued','running','paused_human','paused')
`;

interface ThreadRow {
  run_id: string;
  thread_id: string;
}

/** Distinct `(runId, threadId)` pairs that have ≥1 persisted message
 *  or `llm.start` event under a non-terminal run. Two unioned reads
 *  (messages.node_id covers the common `thread_id == node_id` case;
 *  events.payload covers graph/edge-level thread ids). De-duplication
 *  happens in TS. */
export function selectActiveThreads(db: Database): Array<{ runId: string; threadId: string }> {
  const fromMessages = db.query<ThreadRow, []>(SELECT_THREADS_FROM_MESSAGES_SQL).all();
  const fromEvents = db.query<ThreadRow, []>(SELECT_THREADS_FROM_EVENTS_SQL).all();
  const seen = new Set<string>();
  const out: Array<{ runId: string; threadId: string }> = [];
  for (const row of [...fromMessages, ...fromEvents]) {
    if (row.thread_id == null || row.thread_id === "") continue;
    const key = `${row.run_id}\x00${row.thread_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ runId: row.run_id, threadId: row.thread_id });
  }
  return out;
}
