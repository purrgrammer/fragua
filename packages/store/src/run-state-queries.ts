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
import type { RunStatus } from "@swarm/types";

// ─────────────────────────────────────────────────────────────────────
// Row types
// ─────────────────────────────────────────────────────────────────────

export interface RunStateRow {
  run_id: string;
  version: number;
  status: RunStatus;
  current_node: string | null;
  workflow_sha: string;
  schema_version: number;
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
  workflow_name: string | null;
  workflow_scope: "global" | "local" | "path" | "ephemeral" | null;
  workflow_path: string | null;
  base_git_sha: string | null;
  branch: string | null;
  schedule_id: string | null;
  // Parallel sub-run linkage (P1.1). NULL on top-level runs.
  parent_run_id: string | null;
  parent_node_id: string | null;
  parallel_index: number | null;
  subgraph_root_node_id: string | null;
  subgraph_terminal_node_id: string | null;
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

const SELECT_RUN_STATE_FULL_SQL = `
  SELECT run_id, version, status, current_node, workflow_sha,
         schema_version, routing, metrics, next_seq, last_applied_seq,
         priority, enqueued_at, ready_at, node_started_at,
         dispatch_started_at, updated_at, title,
         cwd, workflow_name, workflow_scope, workflow_path,
         base_git_sha, branch, schedule_id,
         parent_run_id, parent_node_id, parallel_index,
         subgraph_root_node_id, subgraph_terminal_node_id
    FROM run_state
   WHERE run_id = ?
`;

export function selectRunStateRow(db: Database, runId: string): RunStateRow | null {
  return db.query<RunStateRow, [string]>(SELECT_RUN_STATE_FULL_SQL).get(runId) ?? null;
}

const COUNT_RUN_STATE_RUNNING_SQL = `
  SELECT COUNT(*) AS n FROM run_state WHERE status = 'running'
`;

const COUNT_RUN_STATE_QUEUED_SQL = `
  SELECT COUNT(*) AS n FROM run_state WHERE status = 'queued'
`;

export function countRunningRuns(db: Database): number {
  return db.query<{ n: number }, []>(COUNT_RUN_STATE_RUNNING_SQL).get()?.n ?? 0;
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
  /** Narrow to sub-runs of a single parent. Exact match against
   *  `run_state.parent_run_id`. Used by `GET /runs/:id/children` (P5 of
   *  docs/proposals/parallel.md). Backed by `idx_run_state_parent`. */
  parentRunId?: string;
  /** "newest" → most-recently-updated first (archive view). "oldest" →
   *  smallest enqueued_at first (Inbox metaphor — neglect surfaces). */
  order?: "newest" | "oldest";
  /** SQL `LIMIT` cap. Omitted = unbounded. */
  limit?: number;
}

export interface ListRunSummaryRowsOpts extends ListRunIdsOpts {
  /** Exclude sub-runs. Used by top-level `GET /runs`; child lists pass
   *  `parentRunId` instead. */
  topLevelOnly?: boolean;
}

export interface RunSummaryRow {
  runId: string;
  workflowSha: string;
  workflowName: string | null;
  status: RunStatus;
  routing: string;
  title: string | null;
  eventTitle: string | null;
  parentTitle: string | null;
  cwd: string | null;
  parentRunId: string | null;
  parentNodeId: string | null;
  parallelIndex: number | null;
  branchNodeId: string | null;
  enqueuedAt: number;
  firstEventTs: number | null;
  lastEventTs: number | null;
  eventCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
}

/** Enumerate run ids with filtering, ordering, and limit pushed into SQL.
 *  Returns `[]` for `statuses: []` without hitting the DB. */
export function selectRunIds(db: Database, opts: ListRunIdsOpts = {}): string[] {
  const { statuses, cwd, parentRunId, order = "newest", limit } = opts;
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
  if (parentRunId !== undefined) {
    clauses.push("parent_run_id = ?");
    args.push(parentRunId);
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

/** SQL-backed projection for `GET /runs` / child-run summary rows.
 *  Avoids hydrating full event logs just to derive count, duration, and
 *  title fallback. */
export function selectRunSummaryRows(db: Database, opts: ListRunSummaryRowsOpts = {}): RunSummaryRow[] {
  const { statuses, cwd, parentRunId, order = "newest", limit, topLevelOnly } = opts;
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
  if (parentRunId !== undefined) {
    clauses.push("r.parent_run_id = ?");
    args.push(parentRunId);
  } else if (topLevelOnly === true) {
    clauses.push("r.parent_run_id IS NULL");
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const orderBy = order === "oldest" ? "r.enqueued_at ASC" : "r.updated_at DESC";
  const limitClause = limit !== undefined ? "LIMIT ?" : "";
  if (limit !== undefined) args.push(limit);

  const sql = `
    WITH selected AS (
      SELECT r.run_id, r.workflow_sha, r.workflow_name, r.status, r.routing, r.metrics,
             r.title, r.cwd, r.parent_run_id, r.parent_node_id, r.parallel_index,
             r.subgraph_root_node_id, r.enqueued_at, r.updated_at
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
           parent.title AS parentTitle,
           s.cwd AS cwd,
           s.parent_run_id AS parentRunId,
           s.parent_node_id AS parentNodeId,
           s.parallel_index AS parallelIndex,
           s.subgraph_root_node_id AS branchNodeId,
           s.enqueued_at AS enqueuedAt,
           eb.firstEventTs AS firstEventTs,
           eb.lastEventTs AS lastEventTs,
           COALESCE(eb.eventCount, 0) AS eventCount,
           CAST(COALESCE(json_extract(s.metrics, '$.totalCostUsd'), 0) AS REAL) AS totalCostUsd,
           CAST(COALESCE(json_extract(s.metrics, '$.totalInputTokens'), 0) AS INTEGER) AS totalInputTokens,
           CAST(COALESCE(json_extract(s.metrics, '$.totalOutputTokens'), 0) AS INTEGER) AS totalOutputTokens,
           CAST(COALESCE(json_extract(s.metrics, '$.totalCacheReadTokens'), 0) AS INTEGER) AS totalCacheReadTokens,
           CAST(COALESCE(json_extract(s.metrics, '$.totalCacheWriteTokens'), 0) AS INTEGER) AS totalCacheWriteTokens
      FROM selected s
      LEFT JOIN workflows w ON w.sha = s.workflow_sha
      LEFT JOIN run_state parent ON parent.run_id = s.parent_run_id
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
 *  filesystem context (CI, integration tests) and have no project to
 *  belong to. */
export function selectCwds(db: Database): CwdSummaryRow[] {
  return db.query<CwdSummaryRow, []>(SELECT_CWDS_SQL).all();
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
  const where = `${SELECT_WAKE_CANDIDATES_BASE_SQL} (${placeholders})`;
  if (opts.autoResumeBefore != null) {
    const sql = `${where}
       AND CAST(json_extract(routing, '$."internal.auto_resume_at"') AS INTEGER) IS NOT NULL
       AND CAST(json_extract(routing, '$."internal.auto_resume_at"') AS INTEGER) <= ?`;
    return db.query<WakeCandidateRow, (RunStatus | number)[]>(sql).all(...opts.statuses, opts.autoResumeBefore);
  }
  return db.query<WakeCandidateRow, RunStatus[]>(where).all(...opts.statuses);
}

// ─────────────────────────────────────────────────────────────────────
// Writes — run lifecycle
// ─────────────────────────────────────────────────────────────────────

const INSERT_RUN_STATE_SQL = `
  INSERT INTO run_state (
    run_id, version, status, current_node, workflow_sha,
    schema_version, routing, metrics, next_seq, last_applied_seq, priority,
    enqueued_at, ready_at, node_started_at, dispatch_started_at, updated_at,
    cwd, workflow_name, workflow_scope, workflow_path, schedule_id,
    parent_run_id, parent_node_id, parallel_index,
    subgraph_root_node_id, subgraph_terminal_node_id
  ) VALUES (?, 1, 'queued', NULL, ?, ?, ?, ?, 1, 0, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export function insertRunState(
  db: Database,
  args: {
    runId: string;
    workflowSha: string;
    schemaVersion: number;
    routing: string;
    metrics: string;
    priority: number;
    enqueuedAt: number;
    readyAt: number;
    updatedAt: number;
    cwd: string | null;
    workflowName: string | null;
    workflowScope: "global" | "local" | "path" | "ephemeral" | null;
    workflowPath: string | null;
    scheduleId: string | null;
    parentRunId: string | null;
    parentNodeId: string | null;
    parallelIndex: number | null;
    subgraphRootNodeId: string | null;
    subgraphTerminalNodeId: string | null;
  },
): void {
  db.query(INSERT_RUN_STATE_SQL).run(
    args.runId,
    args.workflowSha,
    args.schemaVersion,
    args.routing,
    args.metrics,
    args.priority,
    args.enqueuedAt,
    args.readyAt,
    args.updatedAt,
    args.cwd,
    args.workflowName,
    args.workflowScope,
    args.workflowPath,
    args.scheduleId,
    args.parentRunId,
    args.parentNodeId,
    args.parallelIndex,
    args.subgraphRootNodeId,
    args.subgraphTerminalNodeId,
  );
}

const UPDATE_RUN_STATE_TITLE_SQL = `
  UPDATE run_state SET title = ?, updated_at = ? WHERE run_id = ?
`;

export function updateRunStateTitle(db: Database, runId: string, title: string, now: number): void {
  db.query(UPDATE_RUN_STATE_TITLE_SQL).run(title, now, runId);
}

// Sub-run claim invariant (P1.1 of docs/proposals/parallel.md):
//   a queued row is ONLY claimable when either
//     - it's top-level (parent_run_id IS NULL), OR
//     - its parent's status is 'running_children' (meaning the parent
//       has committed fact.fanout_started and is awaiting its children).
//
// Without this filter, the executor would race: children are enqueued
// in N separate transactions BEFORE the parent commits fact.fanout_started,
// so a concurrent tick can claim a child while the parent is still
// 'running' (no `parallel.<node>.sub_run_ids` on routing yet). The
// child would then dispatch, complete, and try to wake the parent
// out of a state it never entered.
//
// The EXISTS subquery hits the run_state(run_id) primary key — O(1)
// per queued row; idx_run_state_parent makes the outer filter cheap.
// Parent-status check uses `IN` so a future status (e.g. paused
// running_children) only needs a literal added here.
const SELECT_NEXT_QUEUED_RUN_SQL = `
  SELECT run_id, version FROM run_state
   WHERE status = 'queued'
     AND (
       parent_run_id IS NULL
       OR EXISTS (
         SELECT 1 FROM run_state p
          WHERE p.run_id = run_state.parent_run_id
            AND p.status = 'running_children'
       )
     )
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
    branch              = ?
  WHERE run_id = ?
`;

/** Write the projected run_state row. Caller serializes routing +
 *  metrics to JSON; nothing else is computed here. Runs inside the
 *  appendFact transaction. */
export function writeRunStateProjection(
  db: Database,
  args: {
    runId: string;
    version: number;
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
    branch: string | null;
  },
): void {
  db.query(WRITE_PROJECTION_SQL).run(
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
    args.branch,
    args.runId,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Cost rollup for parents with running sub-runs (P1.4)
// ─────────────────────────────────────────────────────────────────────

export interface ParentCostSnapshot {
  /** Parent's own `total_cost_usd` from its `run_state.metrics`. Already
   *  includes folded `fact.subrun_completed` rollup contributions
   *  (terminal sub-runs' cost lands here via the reducer). */
  ownCostUsd: number;
  /** Sum of `total_cost_usd` across every sub-run whose
   *  `parent_run_id = ?` AND whose status is non-terminal (i.e. still
   *  in-flight). Terminal sub-runs are excluded because their cost is
   *  already counted in `ownCostUsd` via the rollup. */
  inFlightCostUsd: number;
  /** Same shape for billed tokens. */
  ownBilledTokens: number;
  inFlightBilledTokens: number;
}

const PARENT_COST_SNAPSHOT_SQL = `
  SELECT
    (SELECT COALESCE(total_cost_usd, 0)
       FROM run_state
      WHERE run_id = ?) AS ownCostUsd,
    (SELECT COALESCE(billed_tokens, 0)
       FROM run_state
      WHERE run_id = ?) AS ownBilledTokens,
    COALESCE(SUM(c.total_cost_usd), 0) AS inFlightCostUsd,
    COALESCE(SUM(c.billed_tokens), 0) AS inFlightBilledTokens
    FROM run_state c
   WHERE c.parent_run_id = ?
     AND c.status NOT IN ('completed','cancelled','halted')
`;

/** Aggregate the cost-gate snapshot for a parent run currently in
 *  `running_children`: own projection plus every in-flight sub-run's
 *  live `total_cost_usd`. Terminal sub-run cost is already folded into
 *  the parent's metrics via `fact.subrun_completed` (reducer), so we
 *  exclude them here to avoid double-counting. See D3 of
 *  `docs/proposals/parallel.md`. */
export function selectParentCostSnapshot(db: Database, parentRunId: string): ParentCostSnapshot {
  const row = db
    .query<
      { ownCostUsd: number; ownBilledTokens: number; inFlightCostUsd: number; inFlightBilledTokens: number },
      [string, string, string]
    >(PARENT_COST_SNAPSHOT_SQL)
    .get(parentRunId, parentRunId, parentRunId);
  return {
    ownCostUsd: row?.ownCostUsd ?? 0,
    ownBilledTokens: row?.ownBilledTokens ?? 0,
    inFlightCostUsd: row?.inFlightCostUsd ?? 0,
    inFlightBilledTokens: row?.inFlightBilledTokens ?? 0,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Sub-run discovery for cancel propagation (P1.5)
// ─────────────────────────────────────────────────────────────────────

const SELECT_ACTIVE_CHILDREN_SQL = `
  SELECT run_id
    FROM run_state
   WHERE parent_run_id = ?
     AND status NOT IN ('completed','cancelled','halted')
`;

/** Returns the run-id list of every sub-run linked to `parentRunId`
 *  that has not yet reached a terminal status. Used by cancel
 *  propagation (D10): cancelling a parent appends
 *  `intent.cancel_requested` on each of these. */
export function selectActiveChildren(db: Database, parentRunId: string): string[] {
  return db
    .query<{ run_id: string }, [string]>(SELECT_ACTIVE_CHILDREN_SQL)
    .all(parentRunId)
    .map((r) => r.run_id);
}

// ─────────────────────────────────────────────────────────────────────
// Metrics-only delta (no OCC, no event)
// ─────────────────────────────────────────────────────────────────────

/** Additive deltas to `run_state.metrics` JSON, applied in a single
 *  `UPDATE … SET metrics = json_set(…)` so neither JS nor any external
 *  process needs to read-modify-write. Powers cross-run cost rollup
 *  (parent absorbs completed sub-run cost) without churning the parent's
 *  OCC version. See P0.3 of `docs/proposals/parallel.md`.
 *
 *  Only numeric fields supported. Map-shaped fields (`models`,
 *  `nodeCosts`, `loopCounts`) require non-trivial merge semantics and
 *  flow through the reducer via `fact.node_completed` instead. */
export interface MetricsDeltaRow {
  billedTokens: number;
  totalCostUsd: number;
  totalInputCostUsd: number;
  totalOutputCostUsd: number;
  totalCacheReadCostUsd: number;
  totalCacheWriteCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  activeMs: number;
}

const APPLY_METRICS_DELTA_SQL = `
  UPDATE run_state
     SET metrics = json_set(
           metrics,
           '$.billedTokens',           CAST(COALESCE(json_extract(metrics, '$.billedTokens'),           0) AS INTEGER) + ?,
           '$.totalCostUsd',           CAST(COALESCE(json_extract(metrics, '$.totalCostUsd'),           0) AS REAL)    + ?,
           '$.totalInputCostUsd',      CAST(COALESCE(json_extract(metrics, '$.totalInputCostUsd'),      0) AS REAL)    + ?,
           '$.totalOutputCostUsd',     CAST(COALESCE(json_extract(metrics, '$.totalOutputCostUsd'),     0) AS REAL)    + ?,
           '$.totalCacheReadCostUsd',  CAST(COALESCE(json_extract(metrics, '$.totalCacheReadCostUsd'),  0) AS REAL)    + ?,
           '$.totalCacheWriteCostUsd', CAST(COALESCE(json_extract(metrics, '$.totalCacheWriteCostUsd'), 0) AS REAL)    + ?,
           '$.totalInputTokens',       CAST(COALESCE(json_extract(metrics, '$.totalInputTokens'),       0) AS INTEGER) + ?,
           '$.totalOutputTokens',      CAST(COALESCE(json_extract(metrics, '$.totalOutputTokens'),      0) AS INTEGER) + ?,
           '$.totalCacheReadTokens',   CAST(COALESCE(json_extract(metrics, '$.totalCacheReadTokens'),   0) AS INTEGER) + ?,
           '$.totalCacheWriteTokens',  CAST(COALESCE(json_extract(metrics, '$.totalCacheWriteTokens'),  0) AS INTEGER) + ?,
           '$.activeMs',               CAST(COALESCE(json_extract(metrics, '$.activeMs'),               0) AS INTEGER) + ?
         ),
         updated_at = ?
   WHERE run_id = ?
`;

/** Apply an additive metrics delta to `run_state.metrics` without
 *  bumping `version` or appending an event. No-op when `runId` is
 *  unknown (UPDATE matches 0 rows). Runs inside a write transaction —
 *  caller's responsibility to grab the lock. */
export function applyMetricsDelta(db: Database, runId: string, delta: MetricsDeltaRow, now: number): void {
  db.query(APPLY_METRICS_DELTA_SQL).run(
    delta.billedTokens,
    delta.totalCostUsd,
    delta.totalInputCostUsd,
    delta.totalOutputCostUsd,
    delta.totalCacheReadCostUsd,
    delta.totalCacheWriteCostUsd,
    delta.totalInputTokens,
    delta.totalOutputTokens,
    delta.totalCacheReadTokens,
    delta.totalCacheWriteTokens,
    delta.activeMs,
    now,
    runId,
  );
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
    SUM(CASE WHEN status = 'paused_hitl' THEN 1 ELSE 0 END) AS paused,
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
