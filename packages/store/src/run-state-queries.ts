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
         base_git_sha, branch
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
  /** "newest" → most-recently-updated first (archive view). "oldest" →
   *  smallest enqueued_at first (Inbox metaphor — neglect surfaces). */
  order?: "newest" | "oldest";
  /** SQL `LIMIT` cap. Omitted = unbounded. */
  limit?: number;
}

/** Enumerate run ids with filtering, ordering, and limit pushed into SQL.
 *  Returns `[]` for `statuses: []` without hitting the DB. */
export function selectRunIds(db: Database, opts: ListRunIdsOpts = {}): string[] {
  const { statuses, cwd, order = "newest", limit } = opts;
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
 *  ms cutoff — used for paused_retry / paused_provider_retry timer
 *  wake. */
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
    run_id, version, status, current_node, workflow_sha, schema_version,
    routing, metrics, next_seq, last_applied_seq, priority,
    enqueued_at, ready_at, node_started_at, dispatch_started_at, updated_at,
    cwd, workflow_name, workflow_scope, workflow_path
  ) VALUES (?, 1, 'queued', NULL, ?, ?, ?, ?, 1, 0, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
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
   WHERE status = 'queued'
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
  fresh_tokens: number | null;
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
    SUM(
      COALESCE(CAST(json_extract(metrics, '$.totalInputTokens')  AS INTEGER), 0) +
      COALESCE(CAST(json_extract(metrics, '$.totalOutputTokens') AS INTEGER), 0)
    )                  AS fresh_tokens,
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
  fresh_tokens: 0,
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
