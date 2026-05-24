// SQL + typed helpers for the daemon coordination tables:
//   `daemon_events` — append-only audit trail of process lifecycle,
//                     sweep summaries, GC, leak detection, worktree
//                     provisioning. Disjoint from the per-run event log.
//   `daemon_lock`   — single-row guard preventing two daemons writing
//                     concurrently. PID + heartbeat tracked here.

import type { Database } from "bun:sqlite";

// ─────────────────────────────────────────────────────────────────────
// daemon_events table
// ─────────────────────────────────────────────────────────────────────

const INSERT_DAEMON_EVENT_SQL = `
  INSERT INTO daemon_events (type, payload, ts, run_id)
  VALUES (?, ?, ?, ?)
  RETURNING seq
`;

/** Append a daemon event. Returns the assigned `seq` (autoincrement
 *  PK in `daemon_events`, disjoint from the per-run seq space). */
export function insertDaemonEvent(
  db: Database,
  type: string,
  payload: string,
  ts: number,
  runId: string | null,
): number {
  const row = db
    .query<{ seq: number }, [string, string, number, string | null]>(INSERT_DAEMON_EVENT_SQL)
    .get(type, payload, ts, runId);
  if (row == null) throw new Error("daemon_events insert returned no row");
  return row.seq;
}

interface DaemonEventDbRow {
  seq: number;
  type: string;
  payload: string;
  ts: number;
  run_id: string | null;
}

const SELECT_DAEMON_EVENTS_SQL = `
  SELECT seq, type, payload, ts, run_id
    FROM daemon_events
   WHERE seq > ?
   ORDER BY seq ASC
   LIMIT ?
`;

const SELECT_DAEMON_EVENTS_BY_RUN_SQL = `
  SELECT seq, type, payload, ts, run_id
    FROM daemon_events
   WHERE run_id = ? AND seq > ?
   ORDER BY seq ASC
   LIMIT ?
`;

export function selectDaemonEvents(db: Database, sinceSeq: number, limit: number): DaemonEventDbRow[] {
  return db.query<DaemonEventDbRow, [number, number]>(SELECT_DAEMON_EVENTS_SQL).all(sinceSeq, limit);
}

export function selectDaemonEventsByRun(
  db: Database,
  runId: string,
  sinceSeq: number,
  limit: number,
): DaemonEventDbRow[] {
  return db
    .query<DaemonEventDbRow, [string, number, number]>(SELECT_DAEMON_EVENTS_BY_RUN_SQL)
    .all(runId, sinceSeq, limit);
}

// ─────────────────────────────────────────────────────────────────────
// daemon_lock table
// ─────────────────────────────────────────────────────────────────────

interface DaemonLockDbRow {
  pid: number;
  hostname: string;
  started_at: number;
  heartbeat_at: number;
}

const SELECT_DAEMON_LOCK_SQL = `
  SELECT pid, hostname, started_at, heartbeat_at
    FROM daemon_lock WHERE id = 1
`;

export function selectDaemonLock(db: Database): DaemonLockDbRow | null {
  return db.query<DaemonLockDbRow, []>(SELECT_DAEMON_LOCK_SQL).get() ?? null;
}

export interface ServerEndpointDbRow {
  url: string;
  port: number;
  pid: number;
  started_at: number;
  harness_version: string | null;
}

const SELECT_SERVER_ENDPOINT_SQL = `
  SELECT url, port, pid, started_at, harness_version
    FROM server_endpoint WHERE id = 1
`;

export function selectServerEndpoint(db: Database): ServerEndpointDbRow | null {
  return db.query<ServerEndpointDbRow, []>(SELECT_SERVER_ENDPOINT_SQL).get() ?? null;
}

const UPSERT_SERVER_ENDPOINT_SQL = `
  INSERT INTO server_endpoint (id, url, port, pid, started_at, harness_version)
  VALUES (1, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    url            = excluded.url,
    port           = excluded.port,
    pid            = excluded.pid,
    started_at     = excluded.started_at,
    harness_version = excluded.harness_version
`;

/** Publish where the HTTP server can be reached. Written after the listener
 *  binds by whoever owns it — the harness's in-process server or a standalone
 *  `fragua serve`. Singleton: last binder wins (one server per store). */
export function upsertServerEndpoint(
  db: Database,
  url: string,
  port: number,
  pid: number,
  startedAt: number,
  version: string | null,
): void {
  db.query(UPSERT_SERVER_ENDPOINT_SQL).run(url, port, pid, startedAt, version);
}

const DELETE_SERVER_ENDPOINT_SQL = `
  DELETE FROM server_endpoint WHERE id = 1 AND pid = ?
`;

/** Clear the endpoint on clean shutdown. pid-scoped so a server that already
 *  rebound (new pid took the singleton) isn't erased by a late closer. */
export function deleteServerEndpoint(db: Database, pid: number): void {
  db.query(DELETE_SERVER_ENDPOINT_SQL).run(pid);
}

const INSERT_DAEMON_LOCK_SQL = `
  INSERT INTO daemon_lock (id, pid, hostname, started_at, heartbeat_at)
  VALUES (1, ?, ?, ?, ?)
`;

/** Cooperative acquire — fails if the row already exists. Caller checks
 *  `selectDaemonLock` first to decide; `forceAcquireDaemonLock` is the
 *  reaper's path. */
export function insertDaemonLock(db: Database, pid: number, hostname: string, now: number): void {
  db.query(INSERT_DAEMON_LOCK_SQL).run(pid, hostname, now, now);
}

const UPSERT_DAEMON_LOCK_SQL = `
  INSERT INTO daemon_lock (id, pid, hostname, started_at, heartbeat_at)
  VALUES (1, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    pid          = excluded.pid,
    hostname     = excluded.hostname,
    started_at   = excluded.started_at,
    heartbeat_at = excluded.heartbeat_at
`;

/** Reaper takeover — overwrites the existing row unconditionally. */
export function upsertDaemonLock(db: Database, pid: number, hostname: string, now: number): void {
  db.query(UPSERT_DAEMON_LOCK_SQL).run(pid, hostname, now, now);
}

const UPDATE_DAEMON_LOCK_HEARTBEAT_SQL = `
  UPDATE daemon_lock SET heartbeat_at = ? WHERE id = 1 AND pid = ?
`;

export function updateDaemonLockHeartbeat(db: Database, pid: number, now: number): void {
  db.query(UPDATE_DAEMON_LOCK_HEARTBEAT_SQL).run(now, pid);
}

const DELETE_DAEMON_LOCK_SQL = `
  DELETE FROM daemon_lock WHERE id = 1 AND pid = ?
`;

export function deleteDaemonLock(db: Database, pid: number): void {
  db.query(DELETE_DAEMON_LOCK_SQL).run(pid);
}
