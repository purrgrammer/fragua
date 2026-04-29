// Wire types for the /analytics endpoints. Mirrors the shapes returned
// by `packages/server/src/store/analytics-queries.ts` so the client gets
// strong typing on every chart's data without re-deriving the shape.

import type { RunSummary } from "../lib/api.ts";

export type BucketKind = "hour" | "day" | "month";

export interface AnalyticsTotals {
  runs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface RunsBucketRow {
  bucket: number;
  completed: number;
  queued: number;
  running: number;
  paused_hitl: number;
  paused_provider_error: number;
  cancelled: number;
  halted: number;
  quarantined: number;
}

/** Ordered list of `RunsBucketRow` status keys — the canonical stack
 *  order used by the Runs chart (success at the bottom, failures at
 *  the top, in-flight states layered between). Drives bar render
 *  order, tooltip rank, and legend labels. */
export const RUN_STATUS_KEYS = [
  "completed",
  "queued",
  "running",
  "paused_hitl",
  "paused_provider_error",
  "cancelled",
  "halted",
  "quarantined",
] as const;

export type RunStatusKey = (typeof RUN_STATUS_KEYS)[number];

export interface SpendBucketRow {
  bucket: number;
  costUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
}

export interface TokensBucketRow {
  bucket: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CacheBucketRow {
  bucket: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface HaltDistributionRow {
  status: string;
  count: number;
}

export interface ModelDistributionRow {
  model: string;
  costUsd: number;
  tokens: number;
}

export interface TopWorkflowRow {
  workflowSha: string;
  workflowName: string | null;
  runs: number;
  success: number;
  fail: number;
  costUsd: number;
}

export interface AnalyticsPayload {
  window: { fromMs: number; toMs: number; bucket: BucketKind; tzOffsetMinutes: number };
  compareWindow: { fromMs: number; toMs: number } | null;
  totals: {
    current: AnalyticsTotals;
    previous: AnalyticsTotals | null;
  };
  runsByBucket: RunsBucketRow[];
  spendByBucket: SpendBucketRow[];
  tokensByBucket: TokensBucketRow[];
  cacheByBucket: CacheBucketRow[];
  haltDistribution: HaltDistributionRow[];
  modelDistribution: ModelDistributionRow[];
  topWorkflows: TopWorkflowRow[];
}

export interface AnalyticsRunsPage {
  runs: RunSummary[];
  nextCursor: string | null;
}

/**
 * Slice descriptor used for drill-down. Encodes the chart element the
 * user clicked so the drawer can re-issue an `/analytics/runs` request
 * with the right filters AND render a context header explaining the
 * scope ("23 runs · 14:00–15:00 · build-feature").
 */
export interface DrillSlice {
  /** Window override for this slice (e.g. just the clicked bucket). */
  fromMs: number;
  toMs: number;
  /** Optional dimension filters applied on top of the window. */
  workflowSha?: string;
  workflowName?: string;
  haltCategory?: string;
  haltLabel?: string;
  model?: string;
  /** Caption shown in the drawer header. */
  title: string;
}
