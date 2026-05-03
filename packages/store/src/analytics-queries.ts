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

export type BucketKind = "hour" | "day" | "month";

export interface AnalyticsWindow {
  /** Inclusive lower bound on `enqueued_at` (unix ms). */
  fromMs: number;
  /** Exclusive upper bound on `enqueued_at` (unix ms). */
  toMs: number;
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

const KPI_TOTALS_SQL = `
  SELECT
    COUNT(*)                                                                              AS runs,
    COALESCE(SUM(total_cost_usd), 0)                                                      AS costUsd,
    COALESCE(SUM(CAST(json_extract(metrics, '$.totalInputTokens')      AS INTEGER)), 0)   AS inputTokens,
    COALESCE(SUM(CAST(json_extract(metrics, '$.totalOutputTokens')     AS INTEGER)), 0)   AS outputTokens,
    COALESCE(SUM(CAST(json_extract(metrics, '$.totalCacheReadTokens')  AS INTEGER)), 0)   AS cacheReadTokens,
    COALESCE(SUM(CAST(json_extract(metrics, '$.totalCacheWriteTokens') AS INTEGER)), 0)   AS cacheWriteTokens
  FROM run_state
  WHERE enqueued_at >= ?1 AND enqueued_at < ?2
`;

export function getKpiTotals(db: Database, w: AnalyticsWindow): KpiTotalsRow {
  const row = db.query<KpiTotalsRow, [number, number]>(KPI_TOTALS_SQL).get(w.fromMs, w.toMs);
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

// ── Bucketed series ────────────────────────────────────────────────────

export interface RunsByBucketRow {
  bucket: number;
  completed: number;
  queued: number;
  running: number;
  paused_hitl: number;
  paused: number;
  paused_provider_retry: number;
  paused_retry: number;
  cancelled: number;
  halted: number;
  quarantined: number;
}

/** One column per actual run status (mirrors the schema's CHECK enum
 *  and the Outcomes donut), so the Runs chart can stack a single
 *  layer per status without the client having to re-derive what
 *  belongs in "fail" / "paused" / etc. — the chart picks colour and
 *  label from `humanizeHaltReason` / `haltReasonAccentVar`. */
export function getRunsByBucket(db: Database, w: BucketedWindow): RunsByBucketRow[] {
  const bucketExpr = bucketExprFor(w.bucket, w.tzOffsetMinutes);
  const sql = `
    SELECT
      ${bucketExpr} AS bucket,
      SUM(CASE WHEN status = 'completed'             THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'queued'                THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'running'               THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status = 'paused_hitl'           THEN 1 ELSE 0 END) AS paused_hitl,
      SUM(CASE WHEN status = 'paused'                THEN 1 ELSE 0 END) AS paused,
      SUM(CASE WHEN status = 'paused_provider_retry' THEN 1 ELSE 0 END) AS paused_provider_retry,
      SUM(CASE WHEN status = 'paused_retry'          THEN 1 ELSE 0 END) AS paused_retry,
      SUM(CASE WHEN status = 'cancelled'             THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN status = 'halted'                THEN 1 ELSE 0 END) AS halted,
      SUM(CASE WHEN status = 'quarantined'           THEN 1 ELSE 0 END) AS quarantined
    FROM run_state
    WHERE enqueued_at >= ?1 AND enqueued_at < ?2
    GROUP BY bucket
    ORDER BY bucket
  `;
  return db.query<RunsByBucketRow, [number, number]>(sql).all(w.fromMs, w.toMs);
}

export interface SpendByBucketRow {
  bucket: number;
  /** Total cost = input + output (+ any cache/other) per the run-level
   *  `total_cost_usd` generated column. The split fields below sum the
   *  reducer-projected `metrics.totalInputCostUsd` /
   *  `metrics.totalOutputCostUsd`; runs that pre-date the split show 0
   *  in the components but still contribute to `costUsd`. */
  costUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
}

export function getSpendByBucket(db: Database, w: BucketedWindow): SpendByBucketRow[] {
  const bucketExpr = bucketExprFor(w.bucket, w.tzOffsetMinutes);
  // Fallback ladder per run for the input/output split:
  //   1. If the reducer recorded a split (`totalInput/OutputCostUsd` non-zero),
  //      use it verbatim.
  //   2. Otherwise, if input/output token counts are present, split
  //      `total_cost_usd` by the token ratio. Approximate but visually
  //      truthful — keeps pre-split runs from rendering as empty stacks.
  //   3. As a last resort, split 50/50.
  const inputCost = `
    CASE
      WHEN COALESCE(CAST(json_extract(metrics, '$.totalInputCostUsd')  AS REAL), 0) > 0
        OR COALESCE(CAST(json_extract(metrics, '$.totalOutputCostUsd') AS REAL), 0) > 0
        THEN COALESCE(CAST(json_extract(metrics, '$.totalInputCostUsd') AS REAL), 0)
      WHEN COALESCE(CAST(json_extract(metrics, '$.totalInputTokens')  AS REAL), 0)
         + COALESCE(CAST(json_extract(metrics, '$.totalOutputTokens') AS REAL), 0) > 0
        THEN total_cost_usd
             * COALESCE(CAST(json_extract(metrics, '$.totalInputTokens') AS REAL), 0)
             / (COALESCE(CAST(json_extract(metrics, '$.totalInputTokens')  AS REAL), 0)
              + COALESCE(CAST(json_extract(metrics, '$.totalOutputTokens') AS REAL), 0))
      ELSE total_cost_usd * 0.5
    END
  `;
  const outputCost = `
    CASE
      WHEN COALESCE(CAST(json_extract(metrics, '$.totalInputCostUsd')  AS REAL), 0) > 0
        OR COALESCE(CAST(json_extract(metrics, '$.totalOutputCostUsd') AS REAL), 0) > 0
        THEN COALESCE(CAST(json_extract(metrics, '$.totalOutputCostUsd') AS REAL), 0)
      WHEN COALESCE(CAST(json_extract(metrics, '$.totalInputTokens')  AS REAL), 0)
         + COALESCE(CAST(json_extract(metrics, '$.totalOutputTokens') AS REAL), 0) > 0
        THEN total_cost_usd
             * COALESCE(CAST(json_extract(metrics, '$.totalOutputTokens') AS REAL), 0)
             / (COALESCE(CAST(json_extract(metrics, '$.totalInputTokens')  AS REAL), 0)
              + COALESCE(CAST(json_extract(metrics, '$.totalOutputTokens') AS REAL), 0))
      ELSE total_cost_usd * 0.5
    END
  `;
  const sql = `
    SELECT
      ${bucketExpr}                       AS bucket,
      COALESCE(SUM(total_cost_usd), 0)    AS costUsd,
      COALESCE(SUM(${inputCost}),  0)     AS inputCostUsd,
      COALESCE(SUM(${outputCost}), 0)     AS outputCostUsd
    FROM run_state
    WHERE enqueued_at >= ?1 AND enqueued_at < ?2
    GROUP BY bucket
    ORDER BY bucket
  `;
  return db.query<SpendByBucketRow, [number, number]>(sql).all(w.fromMs, w.toMs);
}

export interface TokensByBucketRow {
  bucket: number;
  inputTokens: number;
  outputTokens: number;
}

export function getTokensByBucket(db: Database, w: BucketedWindow): TokensByBucketRow[] {
  const bucketExpr = bucketExprFor(w.bucket, w.tzOffsetMinutes);
  const sql = `
    SELECT
      ${bucketExpr}                                                                          AS bucket,
      COALESCE(SUM(CAST(json_extract(metrics, '$.totalInputTokens')  AS INTEGER)), 0)        AS inputTokens,
      COALESCE(SUM(CAST(json_extract(metrics, '$.totalOutputTokens') AS INTEGER)), 0)        AS outputTokens
    FROM run_state
    WHERE enqueued_at >= ?1 AND enqueued_at < ?2
    GROUP BY bucket
    ORDER BY bucket
  `;
  return db.query<TokensByBucketRow, [number, number]>(sql).all(w.fromMs, w.toMs);
}

export interface CacheByBucketRow {
  bucket: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function getCacheByBucket(db: Database, w: BucketedWindow): CacheByBucketRow[] {
  const bucketExpr = bucketExprFor(w.bucket, w.tzOffsetMinutes);
  const sql = `
    SELECT
      ${bucketExpr}                                                                          AS bucket,
      COALESCE(SUM(CAST(json_extract(metrics, '$.totalCacheReadTokens')  AS INTEGER)), 0)    AS cacheReadTokens,
      COALESCE(SUM(CAST(json_extract(metrics, '$.totalCacheWriteTokens') AS INTEGER)), 0)    AS cacheWriteTokens
    FROM run_state
    WHERE enqueued_at >= ?1 AND enqueued_at < ?2
    GROUP BY bucket
    ORDER BY bucket
  `;
  return db.query<CacheByBucketRow, [number, number]>(sql).all(w.fromMs, w.toMs);
}

// ── Distributions ──────────────────────────────────────────────────────

export interface HaltDistributionRow {
  status: string;
  count: number;
}

const HALT_DISTRIBUTION_SQL = `
  SELECT status, COUNT(*) AS count
  FROM run_state
  WHERE enqueued_at >= ?1 AND enqueued_at < ?2
  GROUP BY status
  ORDER BY count DESC
`;

export function getHaltDistribution(db: Database, w: AnalyticsWindow): HaltDistributionRow[] {
  return db.query<HaltDistributionRow, [number, number]>(HALT_DISTRIBUTION_SQL).all(w.fromMs, w.toMs);
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
const MODEL_DISTRIBUTION_SQL = `
  SELECT
    kv.key                                                            AS model,
    COALESCE(SUM(CAST(json_extract(kv.value, '$.costUsd') AS REAL)), 0) AS costUsd,
    COALESCE(SUM(CAST(json_extract(kv.value, '$.tokens')  AS INTEGER)), 0) AS tokens
  FROM run_state, json_each(run_state.metrics, '$.models') AS kv
  WHERE enqueued_at >= ?1 AND enqueued_at < ?2
  GROUP BY kv.key
  ORDER BY costUsd DESC
`;

export function getModelDistribution(db: Database, w: AnalyticsWindow): ModelDistributionRow[] {
  return db.query<ModelDistributionRow, [number, number]>(MODEL_DISTRIBUTION_SQL).all(w.fromMs, w.toMs);
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
const TOP_WORKFLOWS_SQL = `
  SELECT
    rs.workflow_sha                                                       AS workflowSha,
    w.name                                                                AS workflowName,
    COUNT(*)                                                              AS runs,
    SUM(CASE WHEN rs.status = 'completed'               THEN 1 ELSE 0 END) AS success,
    SUM(CASE WHEN rs.status IN ('halted','quarantined') THEN 1 ELSE 0 END) AS fail,
    COALESCE(SUM(rs.total_cost_usd), 0)                                   AS costUsd
  FROM run_state rs
  LEFT JOIN workflows w ON w.sha = rs.workflow_sha
  WHERE rs.enqueued_at >= ?1 AND rs.enqueued_at < ?2
  GROUP BY rs.workflow_sha, w.name
  ORDER BY runs DESC, costUsd DESC
  LIMIT ?3
`;

export function getTopWorkflows(db: Database, w: AnalyticsWindow, limit: number): TopWorkflowRow[] {
  return db.query<TopWorkflowRow, [number, number, number]>(TOP_WORKFLOWS_SQL).all(w.fromMs, w.toMs, limit);
}

// ── Drill-down: paginated run-id list ──────────────────────────────────

export interface DrilldownFilters extends AnalyticsWindow {
  /** Filter to one workflow_sha. */
  workflowSha?: string;
  /** Filter to runs whose lifecycle status matches. Coarse buckets
   *  mirror the four-category collapse the Runs / Outcomes charts
   *  surface: `'success'` → completed; `'failure'` → halted ∪
   *  quarantined ∪ cancelled; `'paused'` → paused_hitl ∪ paused;
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

  if (filters.workflowSha) {
    where.push("rs.workflow_sha = ?");
    params.push(filters.workflowSha);
  }
  if (filters.haltCategory) {
    if (filters.haltCategory === "success") where.push("rs.status = 'completed'");
    else if (filters.haltCategory === "failure") where.push("rs.status IN ('halted','quarantined','cancelled')");
    else if (filters.haltCategory === "paused") where.push("rs.status IN ('paused_hitl','paused')");
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
