// Named SQL aggregations powering the /analytics dashboard.
//
// Module-internal: invoked by SqliteStore via the `getKpiTotals` /
// `getRunsByBucket` / etc. methods on `IEventStore`. The Hono routes
// hit those methods, never these helpers directly — the Database
// handle stays inside the store package.
//
// The contract: every numeric on the wire is summed in SQLite, never
// folded in TypeScript. Each function takes a Database handle plus
// the analytics window and returns shaped, typed rows.
//
// Anchoring: all run-centric metrics use `run_state.enqueued_at` as the
// time axis. A run that started yesterday and finished today is bucketed
// into yesterday — the run's birth time is its identity. Cost / token
// totals come from the run-level `total_cost_usd` / `metrics` snapshot
// (same source `/metrics/global` uses), so the spend attributed to a
// run is its full lifetime spend, not a per-bucket slice.
//
// Time-zone handling: the client passes `tzOffsetMinutes` (the same
// shape `Date.getTimezoneOffset()` returns — positive minutes WEST of
// UTC). The bucket SQL converts UTC ms → local epoch via
// `'unixepoch', '<tz>'`, anchors to the bucket boundary (`'start of
// hour'`-equivalent / `'start of day'` / `'start of month'`), and
// converts back to UTC ms for the wire. This keeps "Today" aligned to
// the user's local midnight on every bucket.

import type { Database } from "bun:sqlite";
import type { RunStatus } from "@fragua/types";

export type BucketKind = "hour" | "day" | "month";

/** Workflow-scope literals on `run_state.workflow_scope`. `'global'` and
 *  `'local'` are user-iterable identities (the selector surfaces them);
 *  `'path'` and `'ephemeral'` runs have no canonical name and stay
 *  unfiltered (they aggregate into "All workflows" only). */
export type WorkflowScopeFilter = "global" | "local";

export interface AnalyticsWindow {
  /** Inclusive lower bound on `enqueued_at` (unix ms). */
  fromMs: number;
  /** Exclusive upper bound on `enqueued_at` (unix ms). */
  toMs: number;
  /** Optional project filter by IDENTITY — exact `run_state.project_id`
   *  match (portable; folds clones/imports). Absent = aggregate across
   *  every project. */
  projectId?: string;
  /** Optional project filter by LOCATION — exact `run_state.cwd` match. */
  cwd?: string;
  /** Optional workflow filter — predicate is `(workflow_scope, workflow_name)`
   *  so all shas of the same identity aggregate together. For
   *  `workflowScope = 'local'` the caller MUST also set `cwd`; without
   *  it the selector would mix the same-named local workflow across
   *  unrelated projects. */
  workflowScope?: WorkflowScopeFilter;
  workflowName?: string;
}

/** Predicate fragment + bind tuple for `(fromMs, toMs[, cwd][, workflow])`.
 *  The fragment is splatted into a `WHERE` clause; the params go into
 *  `db.query(...).all(...params)`. Column reference is parameterised so
 *  callers using `run_state` directly and callers using an alias
 *  (`rs.cwd`) can both reuse it. */
function windowPredicate(
  w: AnalyticsWindow,
  cwdCol: string,
  scopeCol: string = cwdCol === "rs.cwd" ? "rs.workflow_scope" : "workflow_scope",
  nameCol: string = cwdCol === "rs.cwd" ? "rs.workflow_name" : "workflow_name",
  projectIdCol: string = cwdCol === "rs.cwd" ? "rs.project_id" : "project_id",
): { sql: string; params: (number | string)[] } {
  const clauses: string[] = ["enqueued_at >= ?", "enqueued_at < ?"];
  const params: (number | string)[] = [w.fromMs, w.toMs];
  if (w.projectId !== undefined) {
    clauses.push(`${projectIdCol} = ?`);
    params.push(w.projectId);
  }
  if (w.cwd !== undefined) {
    clauses.push(`${cwdCol} = ?`);
    params.push(w.cwd);
  }
  if (w.workflowScope !== undefined && w.workflowName !== undefined) {
    clauses.push(`${scopeCol} = ?`, `${nameCol} = ?`);
    params.push(w.workflowScope, w.workflowName);
  }
  return { sql: clauses.join(" AND "), params };
}

export interface BucketedWindow extends AnalyticsWindow {
  bucket: BucketKind;
  /** `Date.getTimezoneOffset()` shape: positive minutes WEST of UTC. */
  tzOffsetMinutes: number;
}

// ── Time-zone helpers (SQL fragment builders) ──────────────────────────

/** SQLite modifier that shifts a UTC unix timestamp INTO the user's
 *  local wall-clock representation. PT (UTC-8) → `'-480 minutes'`. */
function tzShiftModifier(tzOffsetMinutes: number): string {
  // Positive `tzOffsetMinutes` (e.g. 480 for PT) means local is BEHIND
  // UTC, so we subtract from UTC to land on local wall-clock.
  const sign = tzOffsetMinutes >= 0 ? "-" : "+";
  return `${sign}${Math.abs(tzOffsetMinutes)} minutes`;
}

/** Inverse modifier: shift local wall-clock representation BACK to UTC. */
function tzUnshiftModifier(tzOffsetMinutes: number): string {
  const sign = tzOffsetMinutes >= 0 ? "+" : "-";
  return `${sign}${Math.abs(tzOffsetMinutes)} minutes`;
}

/**
 * SQL fragment producing a unix-ms bucket-start timestamp for the
 * `enqueued_at` column. The fragment is splatted directly into the
 * SELECT — it doesn't take parameters; the TZ modifiers are baked in
 * by the JS builder. (SQLite can't bind into modifier strings.)
 *
 * The math:
 *   1. enqueued_at/1000 → UTC unix seconds
 *   2. 'unixepoch', :tzShift → SQLite Julian, shifted to local wall-clock
 *   3. anchor modifier (start of hour/day/month) → local bucket start
 *   4. :tzUnshift → back to UTC Julian
 *   5. strftime('%s', …) * 1000 → UTC unix ms
 */
function bucketExprFor(bucket: BucketKind, tzOffsetMinutes: number): string {
  const tz = tzShiftModifier(tzOffsetMinutes);
  const tzInv = tzUnshiftModifier(tzOffsetMinutes);
  // SQLite has 'start of day', 'start of month', 'start of year' but no
  // 'start of hour'. Build the hour anchor by formatting to a string at
  // hour precision and reparsing.
  if (bucket === "hour") {
    return `(CAST(strftime('%s', strftime('%Y-%m-%dT%H:00:00', enqueued_at/1000, 'unixepoch', '${tz}'), '${tzInv}') AS INTEGER) * 1000)`;
  }
  const anchor = bucket === "day" ? "start of day" : "start of month";
  return `(CAST(strftime('%s', enqueued_at/1000, 'unixepoch', '${tz}', '${anchor}', '${tzInv}') AS INTEGER) * 1000)`;
}

// ── KPI totals ─────────────────────────────────────────────────────────

export interface KpiTotalsRow {
  runs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function getKpiTotals(db: Database, w: AnalyticsWindow): KpiTotalsRow {
  const pred = windowPredicate(w, "cwd");
  const sql = `
    SELECT
      COUNT(*)                                                                              AS runs,
      COALESCE(SUM(total_cost_usd), 0)                                                      AS costUsd,
      COALESCE(SUM(CAST(json_extract(metrics, '$.totalInputTokens')      AS INTEGER)), 0)   AS inputTokens,
      COALESCE(SUM(CAST(json_extract(metrics, '$.totalOutputTokens')     AS INTEGER)), 0)   AS outputTokens,
      COALESCE(SUM(CAST(json_extract(metrics, '$.totalCacheReadTokens')  AS INTEGER)), 0)   AS cacheReadTokens,
      COALESCE(SUM(CAST(json_extract(metrics, '$.totalCacheWriteTokens') AS INTEGER)), 0)   AS cacheWriteTokens
    FROM run_state
    WHERE ${pred.sql}
  `;
  const row = db.query<KpiTotalsRow, (number | string)[]>(sql).get(...pred.params);
  return (
    row ?? {
      runs: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }
  );
}

// ── Earliest run anchor ──────────────────────────────────────────────

/** Minimum `enqueued_at` across runs matching the analytics window +
 *  filters. Used by the client WindowSelector to decide which lastN
 *  options are available for the visible dataset. Returns `null` when
 *  no rows match (empty table or no runs inside the window). */
export function getFirstRunAt(db: Database, w: AnalyticsWindow): number | null {
  const pred = windowPredicate(w, "cwd");
  const sql = `SELECT MIN(enqueued_at) AS firstRunAt FROM run_state WHERE ${pred.sql}`;
  const row = db.query<{ firstRunAt: number | null }, (number | string)[]>(sql).get(...pred.params);
  return row?.firstRunAt ?? null;
}

// ── Bucketed series ────────────────────────────────────────────────────

export interface RunsByBucketRow {
  bucket: number;
  completed: number;
  queued: number;
  running: number;
  paused_human: number;
  paused: number;
  paused_auto: number;
  cancelled: number;
  halted: number;
  quarantined: number;
}

// Compile-time pin: RunsByBucketRow must carry exactly one numeric column per
// RunStatus (the CASE-WHEN pivot in getRunsByBucket mirrors these columns).
// Adding or removing a RUN_STATUSES literal (@fragua/types) becomes a type
// error here — a missing column fails the first `satisfies`, an extra column
// fails the second — so a new status can't silently yield a zero column.
type RunStatusColumns = Omit<RunsByBucketRow, "bucket">;
const _runsByBucketColumnsCoverRunStatus = {} as RunStatusColumns satisfies Record<RunStatus, number>;
const _runStatusCoversRunsByBucketColumns = {} as Record<RunStatus, number> satisfies RunStatusColumns;
void _runsByBucketColumnsCoverRunStatus;
void _runStatusCoversRunsByBucketColumns;

/** One column per actual run status (mirrors the schema's CHECK enum
 *  and the Outcomes donut), so the Runs chart can stack a single
 *  layer per status without the client having to re-derive what
 *  belongs in "fail" / "paused" / etc. — the chart (RunsChart.tsx,
 *  HaltDonut.tsx) picks colour and label via `categoryLabel` /
 *  `categoryAccentVar`. */
export function getRunsByBucket(db: Database, w: BucketedWindow): RunsByBucketRow[] {
  const bucketExpr = bucketExprFor(w.bucket, w.tzOffsetMinutes);
  const pred = windowPredicate(w, "cwd");
  const sql = `
    SELECT
      ${bucketExpr} AS bucket,
      SUM(CASE WHEN status = 'completed'             THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'queued'                THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'running'               THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status = 'paused_human'          THEN 1 ELSE 0 END) AS paused_human,
      SUM(CASE WHEN status = 'paused'                THEN 1 ELSE 0 END) AS paused,
      SUM(CASE WHEN status = 'paused_auto'           THEN 1 ELSE 0 END) AS paused_auto,
      SUM(CASE WHEN status = 'cancelled'             THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN status = 'halted'                THEN 1 ELSE 0 END) AS halted,
      SUM(CASE WHEN status = 'quarantined'           THEN 1 ELSE 0 END) AS quarantined
    FROM run_state
    WHERE ${pred.sql}
    GROUP BY bucket
    ORDER BY bucket
  `;
  return db.query<RunsByBucketRow, (number | string)[]>(sql).all(...pred.params);
}

export interface SpendByBucketRow {
  bucket: number;
  /** Total cost per the run-level `total_cost_usd` generated column.
   *  The four split fields below sum the reducer-projected
   *  `metrics.total{Input,Output,CacheRead,CacheWrite}CostUsd`. Runs
   *  that pre-date a given split show 0 for that component; when ALL
   *  four splits are 0 the SQL falls back to a token-share approximation
   *  so the bar isn't empty. The four splits + any unattributed
   *  remainder always sum to `costUsd`. */
  costUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
}

export function getSpendByBucket(db: Database, w: BucketedWindow): SpendByBucketRow[] {
  const bucketExpr = bucketExprFor(w.bucket, w.tzOffsetMinutes);
  // Per-bucket fallback ladder with residual redistribution. Handles
  // three states a run can be in cleanly:
  //   - No cost split recorded at all (legacy, pre-split): all four
  //     buckets approximate from `total_cost_usd` × token share.
  //   - Some buckets recorded, others not (transition state — e.g.
  //     input/output split shipped before cache cost split, so
  //     pre-cache-split runs have I/O cost but no cache cost): the
  //     recorded buckets keep their values; the residual
  //     (`total_cost_usd - Σrecorded`) gets distributed across the
  //     unrecorded buckets that have tokens, by token share.
  //   - All four recorded (post b525617 runs): bars match recorded
  //     values exactly; residual ≈ 0; no redistribution.
  //
  // For each bucket i ∈ {Input, Output, CacheRead, CacheWrite}:
  //   - If R_i > 0: use it.
  //   - Else if there's residual to distribute AND this bucket has
  //     tokens: take a share of residual proportional to T_i over
  //     the sum of tokens in unrecorded buckets.
  //   - Else if no buckets recorded ANY cost AND no tokens were
  //     recorded either (synthetic node with $cost but no tokens):
  //     fall back to an even quartersplit.
  //   - Else 0.
  //
  // Invariant: for any run with tokens recorded in at least one
  // unrecorded bucket OR all four cost buckets recorded, the four
  // bucket splits sum to total_cost_usd (within float rounding).
  const r = (k: string) => `COALESCE(CAST(json_extract(metrics, '$.${k}') AS REAL), 0)`;
  const recordedSum = `(
    ${r("totalInputCostUsd")}
  + ${r("totalOutputCostUsd")}
  + ${r("totalCacheReadCostUsd")}
  + ${r("totalCacheWriteCostUsd")}
  )`;
  const residual = `MAX(0, total_cost_usd - ${recordedSum})`;
  const unrecordedTokens = `(
      CASE WHEN ${r("totalInputCostUsd")}      = 0 THEN ${r("totalInputTokens")}      ELSE 0 END
    + CASE WHEN ${r("totalOutputCostUsd")}     = 0 THEN ${r("totalOutputTokens")}     ELSE 0 END
    + CASE WHEN ${r("totalCacheReadCostUsd")}  = 0 THEN ${r("totalCacheReadTokens")}  ELSE 0 END
    + CASE WHEN ${r("totalCacheWriteCostUsd")} = 0 THEN ${r("totalCacheWriteTokens")} ELSE 0 END
  )`;
  const splitFor = (costKey: string, tokenKey: string) => `
    CASE
      WHEN ${r(costKey)} > 0
        THEN ${r(costKey)}
      WHEN ${unrecordedTokens} > 0 AND ${r(tokenKey)} > 0
        THEN ${residual} * ${r(tokenKey)} / ${unrecordedTokens}
      WHEN ${recordedSum} = 0 AND ${unrecordedTokens} = 0 AND total_cost_usd > 0
        THEN total_cost_usd * 0.25
      ELSE 0
    END
  `;
  const pred = windowPredicate(w, "cwd");
  const sql = `
    SELECT
      ${bucketExpr}                       AS bucket,
      COALESCE(SUM(total_cost_usd), 0)    AS costUsd,
      COALESCE(SUM(${splitFor("totalInputCostUsd", "totalInputTokens")}),      0)     AS inputCostUsd,
      COALESCE(SUM(${splitFor("totalOutputCostUsd", "totalOutputTokens")}),     0)     AS outputCostUsd,
      COALESCE(SUM(${splitFor("totalCacheReadCostUsd", "totalCacheReadTokens")}),  0)     AS cacheReadCostUsd,
      COALESCE(SUM(${splitFor("totalCacheWriteCostUsd", "totalCacheWriteTokens")}), 0)     AS cacheWriteCostUsd
    FROM run_state
    WHERE ${pred.sql}
    GROUP BY bucket
    ORDER BY bucket
  `;
  return db.query<SpendByBucketRow, (number | string)[]>(sql).all(...pred.params);
}

export interface TokensByBucketRow {
  bucket: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function getTokensByBucket(db: Database, w: BucketedWindow): TokensByBucketRow[] {
  const bucketExpr = bucketExprFor(w.bucket, w.tzOffsetMinutes);
  const pred = windowPredicate(w, "cwd");
  const sql = `
    SELECT
      ${bucketExpr}                                                                          AS bucket,
      COALESCE(SUM(CAST(json_extract(metrics, '$.totalInputTokens')      AS INTEGER)), 0)    AS inputTokens,
      COALESCE(SUM(CAST(json_extract(metrics, '$.totalOutputTokens')     AS INTEGER)), 0)    AS outputTokens,
      COALESCE(SUM(CAST(json_extract(metrics, '$.totalCacheReadTokens')  AS INTEGER)), 0)    AS cacheReadTokens,
      COALESCE(SUM(CAST(json_extract(metrics, '$.totalCacheWriteTokens') AS INTEGER)), 0)    AS cacheWriteTokens
    FROM run_state
    WHERE ${pred.sql}
    GROUP BY bucket
    ORDER BY bucket
  `;
  return db.query<TokensByBucketRow, (number | string)[]>(sql).all(...pred.params);
}

export interface CacheByBucketRow {
  bucket: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function getCacheByBucket(db: Database, w: BucketedWindow): CacheByBucketRow[] {
  const bucketExpr = bucketExprFor(w.bucket, w.tzOffsetMinutes);
  const pred = windowPredicate(w, "cwd");
  const sql = `
    SELECT
      ${bucketExpr}                                                                          AS bucket,
      COALESCE(SUM(CAST(json_extract(metrics, '$.totalCacheReadTokens')  AS INTEGER)), 0)    AS cacheReadTokens,
      COALESCE(SUM(CAST(json_extract(metrics, '$.totalCacheWriteTokens') AS INTEGER)), 0)    AS cacheWriteTokens
    FROM run_state
    WHERE ${pred.sql}
    GROUP BY bucket
    ORDER BY bucket
  `;
  return db.query<CacheByBucketRow, (number | string)[]>(sql).all(...pred.params);
}

// ── Distributions ──────────────────────────────────────────────────────

export interface HaltDistributionRow {
  status: string;
  count: number;
}

export function getHaltDistribution(db: Database, w: AnalyticsWindow): HaltDistributionRow[] {
  const pred = windowPredicate(w, "cwd");
  const sql = `
    SELECT status, COUNT(*) AS count
    FROM run_state
    WHERE ${pred.sql}
    GROUP BY status
    ORDER BY count DESC
  `;
  return db.query<HaltDistributionRow, (number | string)[]>(sql).all(...pred.params);
}

export interface ModelDistributionRow {
  model: string;
  costUsd: number;
  tokens: number;
}

/** Per-model spend pivot. `run_state.metrics.models` is the projection
 *  the agent layer maintains — keyed by model name, each value carries
 *  `{ tokens, costUsd }`. `json_each` over that object pivots inline so
 *  no per-row TS reduction is needed. */
export function getModelDistribution(db: Database, w: AnalyticsWindow): ModelDistributionRow[] {
  const pred = windowPredicate(w, "run_state.cwd");
  const sql = `
    SELECT
      kv.key                                                            AS model,
      COALESCE(SUM(CAST(json_extract(kv.value, '$.costUsd') AS REAL)), 0) AS costUsd,
      COALESCE(SUM(CAST(json_extract(kv.value, '$.tokens')  AS INTEGER)), 0) AS tokens
    FROM run_state, json_each(run_state.metrics, '$.models') AS kv
    WHERE ${pred.sql}
    GROUP BY kv.key
    ORDER BY costUsd DESC
  `;
  return db.query<ModelDistributionRow, (number | string)[]>(sql).all(...pred.params);
}

export interface TopWorkflowRow {
  workflowSha: string;
  workflowName: string | null;
  runs: number;
  success: number;
  fail: number;
  costUsd: number;
}

/** Most-run workflows in the window, joined to `workflows.name` so the
 *  client doesn't need a second round-trip to look names up. */
export function getTopWorkflows(db: Database, w: AnalyticsWindow, limit: number): TopWorkflowRow[] {
  const pred = windowPredicate(w, "rs.cwd");
  const sql = `
    SELECT
      rs.workflow_sha                                                       AS workflowSha,
      w.name                                                                AS workflowName,
      COUNT(*)                                                              AS runs,
      SUM(CASE WHEN rs.status = 'completed'               THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN rs.status IN ('halted','quarantined') THEN 1 ELSE 0 END) AS fail,
      COALESCE(SUM(rs.total_cost_usd), 0)                                   AS costUsd
    FROM run_state rs
    LEFT JOIN workflows w ON w.sha = rs.workflow_sha
    WHERE ${pred.sql.replace(/enqueued_at/g, "rs.enqueued_at")}
    GROUP BY rs.workflow_sha, w.name
    ORDER BY runs DESC, costUsd DESC
    LIMIT ?
  `;
  return db.query<TopWorkflowRow, (number | string)[]>(sql).all(...pred.params, limit);
}

// ── Workflow directory (selector contents) ─────────────────────────────

export interface WorkflowDirectoryRow {
  scope: WorkflowScopeFilter;
  name: string;
  /** `cwd` of the project the local workflow belongs to. NULL for
   *  `scope = 'global'` (those identities transcend projects). */
  cwd: string | null;
  runCount: number;
  /** `MAX(updated_at)` across the rows that aggregated into this row;
   *  drives the selector's recent-activity ordering. */
  lastActivityMs: number;
}

/** Distinct `(scope, name[, cwd])` identities across `run_state`,
 *  ordered by recent activity. Powers the `WorkflowSelector` on
 *  `/analytics`. Identity rule: shas collapse — every edit of
 *  `research.yaml` shares one row. `path` and `ephemeral` runs are
 *  excluded (no canonical user-iterable identity). When `cwd` is
 *  supplied, only that project's local workflows show; globals are
 *  always returned. */
export function getWorkflowDirectory(db: Database, opts: { cwd?: string }): WorkflowDirectoryRow[] {
  const params: string[] = [];
  // Global workflows: identity = name alone. Aggregate across every
  // project that's run them.
  let globalSql = `
    SELECT
      'global'                AS scope,
      workflow_name           AS name,
      NULL                    AS cwd,
      COUNT(*)                AS runCount,
      MAX(updated_at)         AS lastActivityMs
    FROM run_state
    WHERE workflow_scope = 'global' AND workflow_name IS NOT NULL
  `;
  // Local workflows: identity = (cwd, name). When the caller pins a
  // project, scope to that project; otherwise return per-(cwd, name)
  // entries so the UI can label them with their project.
  let localSql = `
    SELECT
      'local'                 AS scope,
      workflow_name           AS name,
      cwd                     AS cwd,
      COUNT(*)                AS runCount,
      MAX(updated_at)         AS lastActivityMs
    FROM run_state
    WHERE workflow_scope = 'local' AND workflow_name IS NOT NULL AND cwd IS NOT NULL
  `;
  if (opts.cwd !== undefined) {
    localSql += ` AND cwd = ?`;
    params.push(opts.cwd);
  }
  globalSql += ` GROUP BY workflow_name`;
  localSql += ` GROUP BY workflow_name, cwd`;
  const sql = `
    SELECT scope, name, cwd, runCount, lastActivityMs FROM (
      ${globalSql}
      UNION ALL
      ${localSql}
    )
    ORDER BY lastActivityMs DESC
  `;
  return db.query<WorkflowDirectoryRow, string[]>(sql).all(...params);
}

// ── Drill-down: paginated run-id list ──────────────────────────────────

export interface DrilldownFilters extends AnalyticsWindow {
  /** Filter to one workflow_sha. Distinct from
   *  `workflowScope`/`workflowName` (inherited from AnalyticsWindow):
   *  sha is one specific .yaml version, scope+name is every version of
   *  that identity. The two compose — set sha to drill into a single
   *  edit; set scope+name to scope to a workflow lineage. */
  workflowSha?: string;
  // `cwd` inherits from AnalyticsWindow — exact `run_state.cwd` match,
  // applied alongside the other dimensional filters.
  /** Filter to runs whose lifecycle status matches. Coarse buckets
   *  mirror the four-category collapse the Runs / Outcomes charts
   *  surface: `'success'` → completed; `'failure'` → halted ∪
   *  quarantined ∪ cancelled; `'paused'` → paused_human ∪ paused;
   *  `'queued'` → queued ∪ running. Any other
   *  string falls through as a literal RunStatus match. */
  haltCategory?: "success" | "failure" | "paused" | "queued" | string;
  /** Filter to runs whose `metrics.models` contains this model key. */
  model?: string;
}

export interface DrilldownPage {
  runIds: string[];
  /** `null` when this page is the last one. */
  nextCursor: string | null;
}

/** Cursor encodes `(enqueued_at, run_id)` so pagination is stable
 *  against same-ms inserts. Returned base64-url so it can ride a query
 *  string without extra escaping. */
interface DrilldownCursor {
  enqueuedAt: number;
  runId: string;
}

export function encodeCursor(c: DrilldownCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): DrilldownCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<DrilldownCursor>;
    if (typeof parsed.enqueuedAt === "number" && typeof parsed.runId === "string") {
      return { enqueuedAt: parsed.enqueuedAt, runId: parsed.runId };
    }
    return null;
  } catch {
    return null;
  }
}

/** Newest-first scan of run ids matching the analytics filters.
 *  Newest first matches what the drawer wants (most-recent runs in the
 *  bucket on top). Cursor pagination on `(enqueued_at DESC, run_id DESC)`. */
export function getDrilldownPage(
  db: Database,
  filters: DrilldownFilters,
  opts: { limit: number; cursor?: string | undefined },
): DrilldownPage {
  const where: string[] = ["rs.enqueued_at >= ?", "rs.enqueued_at < ?"];
  const params: (number | string)[] = [filters.fromMs, filters.toMs];

  if (filters.cwd !== undefined) {
    where.push("rs.cwd = ?");
    params.push(filters.cwd);
  }
  if (filters.workflowScope !== undefined && filters.workflowName !== undefined) {
    where.push("rs.workflow_scope = ?", "rs.workflow_name = ?");
    params.push(filters.workflowScope, filters.workflowName);
  }
  if (filters.workflowSha) {
    where.push("rs.workflow_sha = ?");
    params.push(filters.workflowSha);
  }
  if (filters.haltCategory) {
    if (filters.haltCategory === "success") where.push("rs.status = 'completed'");
    else if (filters.haltCategory === "failure") where.push("rs.status IN ('halted','quarantined','cancelled')");
    else if (filters.haltCategory === "paused") where.push("rs.status IN ('paused_human','paused')");
    else if (filters.haltCategory === "queued") where.push("rs.status IN ('queued','running')");
    else {
      where.push("rs.status = ?");
      params.push(filters.haltCategory);
    }
  }
  if (filters.model) {
    // EXISTS subquery: at least one model entry in `metrics.models` with
    // a matching key. `json_each` walks the object once per row.
    where.push(`EXISTS (
      SELECT 1 FROM json_each(rs.metrics, '$.models') AS kv WHERE kv.key = ?
    )`);
    params.push(filters.model);
  }

  if (opts.cursor) {
    const cursor = decodeCursor(opts.cursor);
    if (cursor) {
      // Tuple comparison: (enqueued_at, run_id) < (cursor.enqueuedAt, cursor.runId)
      // expressed as the SQL strict-less-than tuple inequality.
      where.push("(rs.enqueued_at < ? OR (rs.enqueued_at = ? AND rs.run_id < ?))");
      params.push(cursor.enqueuedAt, cursor.enqueuedAt, cursor.runId);
    }
  }

  // Fetch limit+1 to detect whether there's another page.
  const sql = `
    SELECT rs.run_id AS runId, rs.enqueued_at AS enqueuedAt
    FROM run_state rs
    WHERE ${where.join(" AND ")}
    ORDER BY rs.enqueued_at DESC, rs.run_id DESC
    LIMIT ?
  `;
  params.push(opts.limit + 1);

  const rows = db.query<{ runId: string; enqueuedAt: number }, (number | string)[]>(sql).all(...params);
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ enqueuedAt: last.enqueuedAt, runId: last.runId }) : null;
  return {
    runIds: page.map((r) => r.runId),
    nextCursor,
  };
}
