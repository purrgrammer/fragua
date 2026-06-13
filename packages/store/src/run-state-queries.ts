// SQL + typed helpers for the `run_state` table and its associated
// projections / aggregates.
//
// Includes:
//   - Run row reads + writes (full SELECT, INSERT, projection UPDATE,
//     title UPDATE, sequence bump, OCC claim).
//   - Run id enumeration + status counts (web `/runs` list, `/health`).
//   - Wake-pending sweep candidates (daemon).
//   - Per-run cost / step aggregates (SQL sums, never folded in TS).
//   - Cross-run global metrics totals + model breakdown
//     (powers `GET /metrics/global`).
//
// `enqueued_at` is the time axis for analytics-shaped reads (a run that
// started yesterday and finished today bucket-counts as yesterday — the
// run's birth time is its identity). Lifecycle reads use `updated_at`
// where they care about recency.

import type { Database } from "bun:sqlite";
import { type InboxStatus, isTerminal, RUN_STATUSES, type RunStatus } from "@fragua/types";

// ─────────────────────────────────────────────────────────────────────
// Shared SQL fragments
// ─────────────────────────────────────────────────────────────────────

/** A run is actionable in the inbox — acceptable or discardable — only if it
 *  has a local worktree, i.e. a non-null `cwd`. This is the negation of the
 *  accept/discard gate (`checkGate` in `@fragua/workspace` refuses `cwd == null`
 *  with `no_worktree`), so the inbox surfaces exactly what those verbs permit.
 *  Imported runs are inert (`cwd` is null) yet re-derive `inbox_status='pending'`
 *  from their folded log; without this they'd appear READY TO LAND but refuse
 *  both accept and discard. Reused by every inbox-scoped query, qualified with
 *  the caller's table alias. */
const LANDABLE_HERE = "cwd IS NOT NULL";

// ─────────────────────────────────────────────────────────────────────
// Row types
// ─────────────────────────────────────────────────────────────────────

export interface RunStateRow {
  run_id: string;
  version: number;
  status: RunStatus;
  current_node: string | null;
  workflow_sha: string;
  contract_version: number;
  routing: string;
  metrics: string;
  next_seq: number;
  last_applied_seq: number;
  priority: number;
  enqueued_at: number;
  ready_at: number;
  node_started_at: number | null;
  dispatch_started_at: number | null;
  updated_at: number;
  title: string | null;
  cwd: string | null;
  project_id: string;
  project_name: string;
  workflow_name: string | null;
  workflow_scope: "global" | "local" | "path" | "ephemeral" | null;
  workflow_path: string | null;
  base_git_sha: string | null;
  base_git_ref: string | null;
  final_git_sha: string | null;
  final_head_ref: string | null;
  diff_base_sha: string | null;
  change_stat: string | null;
  inbox_status: string | null;
  accepted_sha: string | null;
  schedule_id: string | null;
  /** 1 when the run carries the `imported_runs` inert marker, else 0. Computed
   * by the SELECT (not a `run_state` column). */
  imported: number;
}

/** Per-run identity + version + lastAppliedSeq + status. Returned by
 *  `selectWakeCandidates` so the daemon can attempt OCC-protected fact
 *  appends without a second `selectRunRow` round-trip. */
export interface WakeCandidateRow {
  runId: string;
  version: number;
  lastAppliedSeq: number;
  status: RunStatus;
}

// ─────────────────────────────────────────────────────────────────────
// Reads — single row
// ─────────────────────────────────────────────────────────────────────

/** `imported_runs` inert-marker predicate, parameterized by the run-table alias
 *  so it composes in unaliased (`run_state`) and aliased (`r`/`s`) contexts
 *  alike. `importedSql` projects the boolean column; `notImportedSql` is the
 *  dispatch gate — a run is the daemon's to drive toward execution only when it
 *  is NOT imported, spliced into every toward-execution selection (the queued
 *  claim, the concurrency-capacity count, the wake candidates, the crash sweep)
 *  so the marker is honoured uniformly. Imported runs executed elsewhere — they
 *  stay fully inspectable, just invisible to dispatch. */
const importedSql = (alias: string): string =>
  `EXISTS (SELECT 1 FROM imported_runs i WHERE i.run_id = ${alias}.run_id)`;
const notImportedSql = (alias: string): string => `NOT ${importedSql(alias)}`;

const SELECT_RUN_STATE_FULL_SQL = `
  SELECT run_id, version, status, current_node, workflow_sha,
         contract_version, routing, metrics, next_seq, last_applied_seq,
         priority, enqueued_at, ready_at, node_started_at,
         dispatch_started_at, updated_at, title,
         cwd, project_id, project_name, workflow_name, workflow_scope, workflow_path,
         base_git_sha, base_git_ref,
         final_git_sha, final_head_ref, diff_base_sha, change_stat,
         inbox_status, accepted_sha, schedule_id,
         ${importedSql("run_state")} AS imported
    FROM run_state
   WHERE run_id = ?
`;

export function selectRunStateRow(db: Database, runId: string): RunStateRow | null {
  return db.query<RunStateRow, [string]>(SELECT_RUN_STATE_FULL_SQL).get(runId) ?? null;
}

const COUNT_RUN_STATE_RUNNING_SQL = `
  SELECT COUNT(*) AS n FROM run_state WHERE status = 'running'
`;

// Capacity count for the concurrency cap — EXCLUDES imported runs, so an
// imported run that derived to `running` (a non-terminal source run) can never
// burn a live slot. Distinct from the display gauge, which counts them.
const COUNT_DISPATCHABLE_RUNNING_SQL = `
  SELECT COUNT(*) AS n FROM run_state WHERE status = 'running' AND ${notImportedSql("run_state")}
`;

const COUNT_RUN_STATE_QUEUED_SQL = `
  SELECT COUNT(*) AS n FROM run_state WHERE status = 'queued'
`;

/** Display gauge — counts ALL running runs, imported included. */
export function countRunningRuns(db: Database): number {
  return db.query<{ n: number }, []>(COUNT_RUN_STATE_RUNNING_SQL).get()?.n ?? 0;
}

/** Concurrency-capacity count — running runs the daemon could actually execute
 *  here (imported runs excluded). Feeds `claimNextRun`. */
export function countDispatchableRunningRuns(db: Database): number {
  return db.query<{ n: number }, []>(COUNT_DISPATCHABLE_RUNNING_SQL).get()?.n ?? 0;
}

export function countQueuedRuns(db: Database): number {
  return db.query<{ n: number }, []>(COUNT_RUN_STATE_QUEUED_SQL).get()?.n ?? 0;
}

// ─────────────────────────────────────────────────────────────────────
// Reads — enumeration
// ─────────────────────────────────────────────────────────────────────

export interface ListRunIdsOpts {
  /** `WHERE status IN (…)`. Empty array yields zero rows; `undefined`
   *  returns every run. */
  statuses?: RunStatus[];
  /** Narrow to a single project root. Exact match against `run_state.cwd`
   *  (the only project identifier in the harness-by-default model);
   *  `undefined` returns every cwd. NULL `cwd` rows are unreachable from
   *  this filter — by design, since they're ephemeral runs without a
   *  filesystem context. Backed by `idx_run_state_cwd`. */
  cwd?: string;
  /** Narrow to a single project by IDENTITY. Exact match against
   *  `run_state.project_id`; backed by `idx_run_state_project_id`. This is
   *  the portable project filter — unlike `cwd`, it survives clones and
   *  imports. `undefined` returns every project. */
  projectId?: string;
  /** "newest" → most-recently-updated first (archive view). "oldest" →
   *  smallest enqueued_at first (Inbox metaphor — neglect surfaces). */
  order?: "newest" | "oldest";
  /** SQL `LIMIT` cap. Omitted = unbounded. */
  limit?: number;
  /** When `true`, exclude runs that carry the `imported_runs` inert marker.
   *  Operator-worklist surfaces (Inbox) set this so imported inspect-only
   *  runs never appear as actionable items. */
  excludeImported?: boolean;
}

export interface ListRunSummaryRowsOpts extends ListRunIdsOpts {
  /** Narrow to a single inbox status (`pending` powers the worktree inbox
   *  view + `fragua inbox`). `undefined` = no inbox filter. */
  inbox?: InboxStatus;
}

export interface RunSummaryRow {
  runId: string;
  workflowSha: string;
  workflowName: string | null;
  status: RunStatus;
  routing: string;
  title: string | null;
  eventTitle: string | null;
  cwd: string | null;
  projectId: string;
  projectName: string;
  enqueuedAt: number;
  firstEventTs: number | null;
  lastEventTs: number | null;
  eventCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  inboxStatus: string | null;
  changeStat: string | null;
  baseGitRef: string | null;
  baseGitSha: string | null;
  /** 1 when the run carries the `imported_runs` inert marker, else 0. */
  imported: number;
}

/** Enumerate run ids with filtering, ordering, and limit pushed into SQL.
 *  Returns `[]` for `statuses: []` without hitting the DB. */
export function selectRunIds(db: Database, opts: ListRunIdsOpts = {}): string[] {
  const { statuses, cwd, projectId, order = "newest", limit, excludeImported } = opts;
  if (statuses !== undefined && statuses.length === 0) return [];
  const clauses: string[] = [];
  const args: (RunStatus | string | number)[] = [];
  if (statuses) {
    clauses.push(`status IN (${statuses.map(() => "?").join(",")})`);
    args.push(...statuses);
  }
  if (cwd !== undefined) {
    clauses.push("cwd = ?");
    args.push(cwd);
  }
  if (projectId !== undefined) {
    clauses.push("project_id = ?");
    args.push(projectId);
  }
  if (excludeImported) {
    clauses.push(notImportedSql("run_state"));
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const orderBy = order === "oldest" ? "enqueued_at ASC" : "updated_at DESC";
  const limitClause = limit !== undefined ? "LIMIT ?" : "";
  if (limit !== undefined) args.push(limit);
  const sql = `SELECT run_id FROM run_state ${where} ORDER BY ${orderBy} ${limitClause}`;
  return db
    .query<{ run_id: string }, (RunStatus | string | number)[]>(sql)
    .all(...args)
    .map((r) => r.run_id);
}

/** SQL-backed projection for `GET /runs`. Avoids hydrating full event
 *  logs just to derive count, duration, and title fallback. */
export function selectRunSummaryRows(db: Database, opts: ListRunSummaryRowsOpts = {}): RunSummaryRow[] {
  const { statuses, cwd, projectId, order = "newest", limit, inbox, excludeImported } = opts;
  if (statuses !== undefined && statuses.length === 0) return [];

  const clauses: string[] = [];
  const args: (RunStatus | string | number)[] = [];
  if (statuses) {
    clauses.push(`r.status IN (${statuses.map(() => "?").join(",")})`);
    args.push(...statuses);
  }
  if (cwd !== undefined) {
    clauses.push("r.cwd = ?");
    args.push(cwd);
  }
  if (projectId !== undefined) {
    clauses.push("r.project_id = ?");
    args.push(projectId);
  }
  if (inbox !== undefined) {
    clauses.push("r.inbox_status = ?");
    args.push(inbox);
    clauses.push(`r.${LANDABLE_HERE}`);
  }
  if (excludeImported) {
    clauses.push(notImportedSql("r"));
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const orderBy = order === "oldest" ? "r.enqueued_at ASC" : "r.updated_at DESC";
  const limitClause = limit !== undefined ? "LIMIT ?" : "";
  if (limit !== undefined) args.push(limit);

  const sql = `
    WITH selected AS (
      SELECT r.run_id, r.workflow_sha, r.workflow_name, r.status, r.routing, r.metrics,
             r.title, r.cwd, r.project_id, r.project_name, r.enqueued_at, r.updated_at,
             r.inbox_status, r.change_stat, r.base_git_ref, r.base_git_sha
        FROM run_state r
        ${where}
       ORDER BY ${orderBy}, r.run_id ASC
       ${limitClause}
    ),
    event_bounds AS (
      SELECT e.run_id,
             COUNT(*) AS eventCount,
             MIN(e.ts) AS firstEventTs,
             MAX(e.ts) AS lastEventTs
        FROM events e
        JOIN selected s ON s.run_id = e.run_id
       GROUP BY e.run_id
    ),
    latest_title_seq AS (
      SELECT e.run_id, MAX(e.seq) AS seq
        FROM events e
        JOIN selected s ON s.run_id = e.run_id
       WHERE e.type = 'run.title_generated'
       GROUP BY e.run_id
    )
    SELECT s.run_id AS runId,
           s.workflow_sha AS workflowSha,
           COALESCE(s.workflow_name, w.name) AS workflowName,
           s.status AS status,
           s.routing AS routing,
           s.title AS title,
           json_extract(title_event.payload, '$.title') AS eventTitle,
           s.cwd AS cwd,
           s.project_id AS projectId,
           s.project_name AS projectName,
           s.enqueued_at AS enqueuedAt,
           eb.firstEventTs AS firstEventTs,
           eb.lastEventTs AS lastEventTs,
           COALESCE(eb.eventCount, 0) AS eventCount,
           CAST(COALESCE(json_extract(s.metrics, '$.totalCostUsd'), 0) AS REAL) AS totalCostUsd,
           CAST(COALESCE(json_extract(s.metrics, '$.totalInputTokens'), 0) AS INTEGER) AS totalInputTokens,
           CAST(COALESCE(json_extract(s.metrics, '$.totalOutputTokens'), 0) AS INTEGER) AS totalOutputTokens,
           CAST(COALESCE(json_extract(s.metrics, '$.totalCacheReadTokens'), 0) AS INTEGER) AS totalCacheReadTokens,
           CAST(COALESCE(json_extract(s.metrics, '$.totalCacheWriteTokens'), 0) AS INTEGER) AS totalCacheWriteTokens,
           s.inbox_status AS inboxStatus,
           s.change_stat AS changeStat,
           s.base_git_ref AS baseGitRef,
           s.base_git_sha AS baseGitSha,
           ${importedSql("s")} AS imported
      FROM selected s
      LEFT JOIN workflows w ON w.sha = s.workflow_sha
      LEFT JOIN event_bounds eb ON eb.run_id = s.run_id
      LEFT JOIN latest_title_seq lts ON lts.run_id = s.run_id
      LEFT JOIN events title_event ON title_event.run_id = lts.run_id AND title_event.seq = lts.seq
     ORDER BY ${order === "oldest" ? "s.enqueued_at ASC" : "s.updated_at DESC"}, s.run_id ASC
  `;

  return db.query<RunSummaryRow, (RunStatus | string | number)[]>(sql).all(...args);
}

// ─────────────────────────────────────────────────────────────────────
// Reads — project (cwd) enumeration
// ─────────────────────────────────────────────────────────────────────

export interface CwdSummaryRow {
  cwd: string;
  lastUpdatedAt: number;
  runCount: number;
}

const SELECT_CWDS_SQL = `
  SELECT cwd, MAX(updated_at) AS lastUpdatedAt, COUNT(*) AS runCount
    FROM run_state
   WHERE cwd IS NOT NULL
   GROUP BY cwd
   ORDER BY lastUpdatedAt DESC, cwd ASC
`;

/** Distinct `cwd` values across `run_state`, ordered by most-recent
 *  activity. NULL `cwd` rows are excluded — they're runs without a
 *  filesystem context (CI, integration tests). This is a LOCATION view
 *  (where runs physically happened); the IDENTITY view is
 *  `selectProjects`. */
export function selectCwds(db: Database): CwdSummaryRow[] {
  return db.query<CwdSummaryRow, []>(SELECT_CWDS_SQL).all();
}

export interface ProjectSummaryRow {
  projectId: string;
  /** Display label — the most-recent enqueue's `project_name` for this id. */
  projectName: string;
  /** Representative LOCATION hint — the most-recent non-NULL `cwd` seen for
   *  this id, or NULL for an imported-only project never checked out here.
   *  Used to resolve file/tree/blob views; not identity. */
  cwdHint: string | null;
  lastUpdatedAt: number;
  runCount: number;
}

const SELECT_PROJECTS_SQL = `
  SELECT project_id AS projectId,
         (SELECT r2.project_name FROM run_state r2
           WHERE r2.project_id = r.project_id
           ORDER BY r2.updated_at DESC, r2.run_id ASC LIMIT 1) AS projectName,
         (SELECT r3.cwd FROM run_state r3
           WHERE r3.project_id = r.project_id AND r3.cwd IS NOT NULL
           ORDER BY r3.updated_at DESC, r3.run_id ASC LIMIT 1) AS cwdHint,
         MAX(updated_at) AS lastUpdatedAt,
         COUNT(*) AS runCount
    FROM run_state r
   GROUP BY project_id
   ORDER BY lastUpdatedAt DESC, project_id ASC
`;

/** Distinct projects by IDENTITY (`project_id`), ordered by most-recent
 *  activity, with a display label and a representative cwd hint. Unlike
 *  `selectCwds`, this groups imported runs and multiple checkouts of the
 *  same repo into one project, and surfaces projects with no local
 *  checkout. */
export function selectProjects(db: Database): ProjectSummaryRow[] {
  return db.query<ProjectSummaryRow, []>(SELECT_PROJECTS_SQL).all();
}

const SELECT_WAKE_CANDIDATES_BASE_SQL = `
  SELECT run_id      AS runId,
         version,
         last_applied_seq AS lastAppliedSeq,
         status
    FROM run_state
   WHERE status IN`;

/** Run rows in the given statuses. When `autoResumeBefore` is supplied
 *  the row also has to carry `routing.internal.auto_resume_at` ≤ that
 *  ms cutoff — used for `paused_auto` timer wake (covers both provider
 *  and handler retries). */
export function selectWakeCandidates(
  db: Database,
  opts: { statuses: readonly RunStatus[]; autoResumeBefore?: number },
): WakeCandidateRow[] {
  if (opts.statuses.length === 0) return [];
  const placeholders = opts.statuses.map(() => "?").join(",");
  const where = `${SELECT_WAKE_CANDIDATES_BASE_SQL} (${placeholders}) AND ${notImportedSql("run_state")}`;
  if (opts.autoResumeBefore != null) {
    const sql = `${where}
       AND CAST(json_extract(routing, '$."internal.auto_resume_at"') AS INTEGER) IS NOT NULL
       AND CAST(json_extract(routing, '$."internal.auto_resume_at"') AS INTEGER) <= ?`;
    return db.query<WakeCandidateRow, (RunStatus | number)[]>(sql).all(...opts.statuses, opts.autoResumeBefore);
  }
  return db.query<WakeCandidateRow, RunStatus[]>(where).all(...opts.statuses);
}

const SELECT_INBOX_ACTION_CANDIDATES_SQL = `
  SELECT rs.run_id           AS runId,
         rs.version          AS version,
         rs.last_applied_seq AS lastAppliedSeq,
         rs.status           AS status
    FROM run_state rs
   WHERE rs.inbox_status IN ('pending', 'acted')
     AND rs.${LANDABLE_HERE}
     AND EXISTS (
       SELECT 1 FROM events e
        WHERE e.run_id = rs.run_id
          AND e.seq > rs.last_applied_seq
          AND e.type IN (
            'intent.accept_run', 'intent.discard_run'
          )
     )
`;

/** Terminal runs in the inbox (`pending`/`acted`) carrying an unapplied
 *  operator-action intent (branch / commit / merge / discard). Scoped by
 *  the `inbox_status` partial index + an EXISTS over the run's events so the
 *  daemon sweep never walks every terminal run — only those an operator
 *  acted on. The `LANDABLE_HERE` guard excludes inert imported runs (the gate
 *  refuses their accept/discard before any intent is written, so this is
 *  defensive). Mirrors `selectWakeCandidates`' OCC-ready row shape. */
export function selectInboxActionCandidates(db: Database): WakeCandidateRow[] {
  return db.query<WakeCandidateRow, []>(SELECT_INBOX_ACTION_CANDIDATES_SQL).all();
}

export interface GcSnapshotRunRow {
  runId: string;
  status: RunStatus;
  updatedAt: number;
}

const SELECT_GC_ELIGIBLE_SNAPSHOT_RUNS_SQL = `
  SELECT run_id AS runId, status, updated_at AS updatedAt
    FROM run_state
   WHERE cwd = ?
     AND status IN ('completed', 'halted', 'cancelled')
     AND updated_at < ?
     AND (inbox_status IS NULL OR inbox_status <> 'pending')
   ORDER BY updated_at ASC
`;

/** Terminal runs in `cwd` whose snapshot refs are eligible for GC: settled
 *  (not `running`/`queued`/`paused`), older than `cutoff` (ms epoch), and
 *  not awaiting an operator decision (`inbox_status` not `pending`). The
 *  caller deletes each run's `refs/fragua/{snapshots,heads}/<runId>`; runs
 *  that never used a worktree simply have no such refs (a no-op delete). */
export function selectGcEligibleSnapshotRuns(db: Database, opts: { cwd: string; cutoff: number }): GcSnapshotRunRow[] {
  return db.query<GcSnapshotRunRow, [string, number]>(SELECT_GC_ELIGIBLE_SNAPSHOT_RUNS_SQL).all(opts.cwd, opts.cutoff);
}

// ─────────────────────────────────────────────────────────────────────
// Writes — run lifecycle
// ─────────────────────────────────────────────────────────────────────

const INSERT_RUN_STATE_SQL = `
  INSERT INTO run_state (
    run_id, version, status, current_node, workflow_sha,
    contract_version, routing, metrics, next_seq, last_applied_seq, priority,
    enqueued_at, ready_at, node_started_at, dispatch_started_at, updated_at,
    cwd, project_id, project_name, workflow_name, workflow_scope, workflow_path, schedule_id
  ) VALUES (?, 1, 'queued', NULL, ?, ?, ?, ?, 1, 0, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export function insertRunState(
  db: Database,
  args: {
    runId: string;
    workflowSha: string;
    contractVersion: number;
    routing: string;
    metrics: string;
    priority: number;
    enqueuedAt: number;
    readyAt: number;
    updatedAt: number;
    cwd: string | null;
    projectId: string;
    projectName: string;
    workflowName: string | null;
    workflowScope: "global" | "local" | "path" | "ephemeral" | null;
    workflowPath: string | null;
    scheduleId: string | null;
  },
): void {
  db.query(INSERT_RUN_STATE_SQL).run(
    args.runId,
    args.workflowSha,
    args.contractVersion,
    args.routing,
    args.metrics,
    args.priority,
    args.enqueuedAt,
    args.readyAt,
    args.updatedAt,
    args.cwd,
    args.projectId,
    args.projectName,
    args.workflowName,
    args.workflowScope,
    args.workflowPath,
    args.scheduleId,
  );
}

const UPDATE_RUN_STATE_TITLE_SQL = `
  UPDATE run_state SET title = ?, updated_at = ? WHERE run_id = ?
`;

export function updateRunStateTitle(db: Database, runId: string, title: string, now: number): void {
  db.query(UPDATE_RUN_STATE_TITLE_SQL).run(title, now, runId);
}

const SELECT_NEXT_QUEUED_RUN_SQL = `
  SELECT run_id, version FROM run_state
   WHERE status = 'queued' AND ${notImportedSql("run_state")}
   ORDER BY priority DESC, ready_at ASC, run_id ASC
   LIMIT 1
`;

const CLAIM_NEXT_RUN_SQL = `
  UPDATE run_state
     SET status = 'running',
         node_started_at = ?,
         version = version + 1,
         updated_at = ?
   WHERE run_id = ? AND version = ? AND status = 'queued'
   RETURNING run_id
`;

/** OCC-protected claim: select highest-priority queued run, then update
 *  WHERE version matches. Returns the claimed run_id, or null if no
 *  candidate or the version moved between SELECT and UPDATE. */
export function selectNextQueuedRun(db: Database): { run_id: string; version: number } | null {
  return db.query<{ run_id: string; version: number }, []>(SELECT_NEXT_QUEUED_RUN_SQL).get() ?? null;
}

export function claimQueuedRun(
  db: Database,
  args: { runId: string; expectedVersion: number; now: number },
): string | null {
  const res = db
    .query<{ run_id: string }, [number, number, string, number]>(CLAIM_NEXT_RUN_SQL)
    .get(args.now, args.now, args.runId, args.expectedVersion);
  return res?.run_id ?? null;
}

const BUMP_SEQ_SQL = `
  UPDATE run_state
     SET next_seq = next_seq + 1
   WHERE run_id = ?
   RETURNING next_seq - 1 AS seq
`;

export function bumpRunSeq(db: Database, runId: string): number {
  const row = db.query<{ seq: number }, [string]>(BUMP_SEQ_SQL).get(runId);
  if (row == null) throw new Error(`run_state missing for ${runId}`);
  return row.seq;
}

const SET_RUN_STATE_NEXT_SEQ_SQL = `
  UPDATE run_state SET next_seq = ? WHERE run_id = ?
`;

/** Patch `next_seq` directly. Used by bundle import to restore a run's full
 *  projection: `writeRunStateProjection` deliberately omits `next_seq` (it's a
 *  creation column, not a projected one), so import sets it from the source so
 *  any future resume mints the next event at the correct seq. */
export function setRunStateNextSeq(db: Database, runId: string, nextSeq: number): void {
  db.query(SET_RUN_STATE_NEXT_SEQ_SQL).run(nextSeq, runId);
}

const MARK_RUN_IMPORTED_SQL = `
  INSERT OR IGNORE INTO imported_runs (run_id, imported_at) VALUES (?, ?)
`;

/** Stamp the local inert marker for a run merged in by `fragua import` — the
 *  authoritative gate that holds it out of dispatch/concurrency/sweep. Pure
 *  SQL, safe inside the import write txn; INSERT OR IGNORE so a re-import is a
 *  no-op. The marker is local-only — never serialized into a bundle. */
export function markRunImported(db: Database, runId: string, importedAt: number): void {
  db.query(MARK_RUN_IMPORTED_SQL).run(runId, importedAt);
}

const WRITE_PROJECTION_SQL = `
  UPDATE run_state SET
    version             = ?,
    status              = ?,
    current_node        = ?,
    routing             = ?,
    metrics             = ?,
    last_applied_seq    = ?,
    priority            = ?,
    ready_at            = ?,
    node_started_at     = ?,
    dispatch_started_at = ?,
    updated_at          = ?,
    base_git_sha        = ?,
    base_git_ref        = ?,
    final_git_sha       = ?,
    final_head_ref      = ?,
    diff_base_sha       = ?,
    change_stat         = ?,
    inbox_status        = ?,
    accepted_sha        = ?
  WHERE run_id = ? AND version = ?
  RETURNING run_id
`;

/** Write the projected run_state row. Caller serializes routing +
 *  metrics to JSON; nothing else is computed here. Runs inside the
 *  appendFact transaction.
 *
 *  `routing` is persisted as an opaque, unschematized JSON dict, guarded
 *  only by the 8 KB CHECK (I6). Deliberate: it is a fold-rebuildable
 *  projection cache (`deriveRunState` reconstructs it from the event
 *  log), never a second source of truth — see ARCHITECTURE.md §2.1.
 *
 *  OCC guard: the UPDATE only matches when the row still carries
 *  `expectedVersion` (the pre-bump version the caller validated against).
 *  Returns `true` when exactly one row changed, `false` when the version
 *  moved underneath the caller — the caller throws `ConcurrencyError` on
 *  `false` instead of silently corrupting the projection. This makes the
 *  invariant structural; appendFact's pre-check remains as the first line
 *  of defense. */
export function writeRunStateProjection(
  db: Database,
  args: {
    runId: string;
    version: number;
    /** Pre-bump version the row must still hold for the write to apply. */
    expectedVersion: number;
    status: RunStatus;
    currentNode: string | null;
    routingJson: string;
    metricsJson: string;
    lastAppliedSeq: number;
    priority: number;
    readyAt: number;
    nodeStartedAt: number | null;
    dispatchStartedAt: number | null;
    updatedAt: number;
    baseGitSha: string | null;
    baseGitRef: string | null;
    finalGitSha: string | null;
    finalHeadRef: string | null;
    diffBaseSha: string | null;
    changeStatJson: string | null;
    inboxStatus: string | null;
    acceptedSha: string | null;
  },
): boolean {
  const row = db
    .query<{ run_id: string }, (string | number | null)[]>(WRITE_PROJECTION_SQL)
    .get(
      args.version,
      args.status,
      args.currentNode,
      args.routingJson,
      args.metricsJson,
      args.lastAppliedSeq,
      args.priority,
      args.readyAt,
      args.nodeStartedAt,
      args.dispatchStartedAt,
      args.updatedAt,
      args.baseGitSha,
      args.baseGitRef,
      args.finalGitSha,
      args.finalHeadRef,
      args.diffBaseSha,
      args.changeStatJson,
      args.inboxStatus,
      args.acceptedSha,
      args.runId,
      args.expectedVersion,
    );
  return row != null;
}

// ─────────────────────────────────────────────────────────────────────
// Per-run aggregates (sums of cost.recorded events)
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
  return db.query<StepAggregateRow, [string]>(STEP_AGGREGATES_SQL).all(runId);
}

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
// Cross-run global metrics (powers GET /metrics/global)
// ─────────────────────────────────────────────────────────────────────

export interface GlobalMetricsTotalsRow {
  total_runs: number;
  total_usd: number | null;
  billed_tokens: number | null;
  successful: number;
  halted: number;
  running: number;
  queued: number;
  paused: number;
  quarantined: number;
}

const SELECT_GLOBAL_METRICS_TOTALS_SQL = `
  SELECT
    COUNT(*) AS total_runs,
    SUM(total_cost_usd) AS total_usd,
    SUM(billed_tokens) AS billed_tokens,
    SUM(CASE WHEN status = 'completed'   THEN 1 ELSE 0 END) AS successful,
    SUM(CASE WHEN status = 'halted'      THEN 1 ELSE 0 END) AS halted,
    SUM(CASE WHEN status = 'running'     THEN 1 ELSE 0 END) AS running,
    SUM(CASE WHEN status = 'queued'      THEN 1 ELSE 0 END) AS queued,
    SUM(CASE WHEN status = 'paused_human' THEN 1 ELSE 0 END) AS paused,
    SUM(CASE WHEN status = 'quarantined' THEN 1 ELSE 0 END) AS quarantined
  FROM run_state
  WHERE updated_at >= ?
`;

const ZERO_GLOBAL_METRICS: GlobalMetricsTotalsRow = {
  total_runs: 0,
  total_usd: 0,
  billed_tokens: 0,
  successful: 0,
  halted: 0,
  running: 0,
  queued: 0,
  paused: 0,
  quarantined: 0,
};

export function selectGlobalMetricsTotals(db: Database, sinceMs: number): GlobalMetricsTotalsRow {
  const row = db.query<GlobalMetricsTotalsRow, [number]>(SELECT_GLOBAL_METRICS_TOTALS_SQL).get(sinceMs);
  return row ?? ZERO_GLOBAL_METRICS;
}

export interface GlobalModelBreakdownRow {
  model_name: string;
  tokens: number;
  cost_usd: number;
}

const SELECT_GLOBAL_MODEL_BREAKDOWN_SQL = `
  SELECT
    kv.key  AS model_name,
    SUM(CAST(json_extract(kv.value, '$.tokens')  AS INTEGER))  AS tokens,
    SUM(CAST(json_extract(kv.value, '$.costUsd') AS REAL))     AS cost_usd
  FROM run_state, json_each(run_state.metrics, '$.models') AS kv
  WHERE updated_at >= ?
  GROUP BY kv.key
  ORDER BY cost_usd DESC
`;

export function selectGlobalModelBreakdown(db: Database, sinceMs: number): GlobalModelBreakdownRow[] {
  return db.query<GlobalModelBreakdownRow, [number]>(SELECT_GLOBAL_MODEL_BREAKDOWN_SQL).all(sinceMs);
}

// ─────────────────────────────────────────────────────────────────────
// Fleet rollup (powers `fragua runs ls --summary`)
// ─────────────────────────────────────────────────────────────────────

export interface FleetSummaryOpts {
  /** `WHERE status IN (…)` scope. Empty array yields an empty summary;
   *  `undefined` covers every status. Mirrors `selectRunIds`. */
  statuses?: RunStatus[];
  /** Narrow to one project root (`run_state.cwd`). */
  cwd?: string;
  /** Scope the aggregated set to the most-recently-updated `limit` runs
   *  (the same window the per-run `ls` list would show). Omitted =
   *  unbounded. */
  limit?: number;
}

/** One per-workflow row: `running` / `done` (completed) / `failed`
 *  (halted + cancelled) counts, plus the row total. */
export interface FleetWorkflowRow {
  workflow: string;
  running: number;
  done: number;
  failed: number;
  total: number;
}

export interface FleetSummary {
  /** Count per lifecycle status. Every {@link RUN_STATUSES} key is present
   *  (zero-filled), so a renderer never has to guess at missing buckets. */
  statusCounts: Record<RunStatus, number>;
  /** Per-workflow breakdown, busiest-first. */
  workflows: FleetWorkflowRow[];
  /** SUM of `total_cost_usd` across NON-terminal runs (the live burn —
   *  excludes completed / cancelled / halted). */
  inFlightCostUsd: number;
  /** Total runs in scope (after filters + limit). */
  totalRuns: number;
}

/** Build the `WHERE`/args + the `WITH selected` CTE shared by every fleet
 *  aggregation, so the `--status` / `--cwd` filters and the `--limit` scope
 *  bound the AGGREGATED set, not the output rows. Imported runs are always
 *  excluded (they executed elsewhere). */
function fleetSelectedCte(opts: FleetSummaryOpts): { cte: string; args: (string | number)[] } {
  const { statuses, cwd, limit } = opts;
  const clauses: string[] = [notImportedSql("run_state")];
  const args: (string | number)[] = [];
  if (statuses) {
    clauses.push(`status IN (${statuses.map(() => "?").join(",")})`);
    args.push(...statuses);
  }
  if (cwd !== undefined) {
    clauses.push("cwd = ?");
    args.push(cwd);
  }
  const limitClause = limit !== undefined ? "LIMIT ?" : "";
  if (limit !== undefined) args.push(limit);
  const cte = `
    WITH selected AS (
      SELECT status, workflow_name, total_cost_usd
        FROM run_state
       WHERE ${clauses.join(" AND ")}
       ORDER BY updated_at DESC, run_id ASC
       ${limitClause}
    )`;
  return { cte, args };
}

/** Non-terminal statuses, derived from the source-of-truth tuple so the
 *  in-flight cost scope can't drift as the lifecycle evolves. */
const NON_TERMINAL_STATUSES: readonly RunStatus[] = RUN_STATUSES.filter((s) => !isTerminal(s));

/** Fleet rollup: status counts, per-workflow breakdown, and total in-flight
 *  cost — all in SQL, never a TS fold. `statuses: []` short-circuits to an
 *  empty summary without hitting the DB. */
export function selectFleetSummary(db: Database, opts: FleetSummaryOpts = {}): FleetSummary {
  const statusCounts = Object.fromEntries(RUN_STATUSES.map((s) => [s, 0])) as Record<RunStatus, number>;
  if (opts.statuses !== undefined && opts.statuses.length === 0) {
    return { statusCounts, workflows: [], inFlightCostUsd: 0, totalRuns: 0 };
  }

  const { cte, args } = fleetSelectedCte(opts);

  const countRows = db
    .query<{ status: RunStatus; n: number }, (string | number)[]>(
      `${cte} SELECT status, COUNT(*) AS n FROM selected GROUP BY status`,
    )
    .all(...args);
  let totalRuns = 0;
  for (const row of countRows) {
    statusCounts[row.status] = row.n;
    totalRuns += row.n;
  }

  const workflows = db
    .query<FleetWorkflowRow, (string | number)[]>(
      `${cte}
       SELECT COALESCE(workflow_name, '(unknown)') AS workflow,
              SUM(CASE WHEN status = 'running'             THEN 1 ELSE 0 END) AS running,
              SUM(CASE WHEN status = 'completed'          THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN status IN ('halted', 'cancelled') THEN 1 ELSE 0 END) AS failed,
              COUNT(*) AS total
         FROM selected
        GROUP BY workflow
        ORDER BY total DESC, workflow ASC`,
    )
    .all(...args);

  const placeholders = NON_TERMINAL_STATUSES.map(() => "?").join(",");
  const cost = db
    .query<{ inFlightCostUsd: number }, (string | number)[]>(
      `${cte}
       SELECT COALESCE(SUM(CASE WHEN status IN (${placeholders}) THEN total_cost_usd ELSE 0 END), 0)
              AS inFlightCostUsd
         FROM selected`,
    )
    .get(...args, ...NON_TERMINAL_STATUSES);

  return { statusCounts, workflows, inFlightCostUsd: cost?.inFlightCostUsd ?? 0, totalRuns };
}

const SELECT_ALL_ROUTINGS_SQL = `SELECT routing FROM run_state`;

/** Return the raw routing JSON strings for every run — used by gcBlobs to
 *  collect routing-referenced blob shas as GC roots. */
export function selectAllRoutings(db: Database): string[] {
  return db
    .query<{ routing: string }, []>(SELECT_ALL_ROUTINGS_SQL)
    .all()
    .map((r) => r.routing);
}
