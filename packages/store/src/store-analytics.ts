import {
  type AnalyticsWindow,
  type BucketedWindow,
  type CacheByBucketRow,
  type DrilldownFilters,
  type DrilldownPage,
  type HaltDistributionRow,
  type KpiTotalsRow,
  type ModelDistributionRow,
  getCacheByBucket as queryCacheByBucket,
  getDrilldownPage as queryDrilldownPage,
  getFirstRunAt as queryFirstRunAt,
  getHaltDistribution as queryHaltDistribution,
  getKpiTotals as queryKpiTotals,
  getModelDistribution as queryModelDistribution,
  getRunsByBucket as queryRunsByBucket,
  getSpendByBucket as querySpendByBucket,
  getTokensByBucket as queryTokensByBucket,
  getTopWorkflows as queryTopWorkflows,
  getWorkflowDirectory as queryWorkflowDirectory,
  type RunsByBucketRow,
  type SpendByBucketRow,
  type TokensByBucketRow,
  type TopWorkflowRow,
  type WorkflowDirectoryRow,
} from "./analytics-queries.ts";
import {
  type GlobalMetricsTotalsRow,
  type GlobalModelBreakdownRow,
  selectGlobalMetricsTotals,
  selectGlobalModelBreakdown,
} from "./run-state-queries.ts";
import type { StoreCtx } from "./store-ctx.ts";

export function getKpiTotals(ctx: StoreCtx, window: AnalyticsWindow): KpiTotalsRow {
  return queryKpiTotals(ctx.db, window);
}

export function getRunsByBucket(ctx: StoreCtx, window: BucketedWindow): RunsByBucketRow[] {
  return queryRunsByBucket(ctx.db, window);
}

export function getSpendByBucket(ctx: StoreCtx, window: BucketedWindow): SpendByBucketRow[] {
  return querySpendByBucket(ctx.db, window);
}

export function getTokensByBucket(ctx: StoreCtx, window: BucketedWindow): TokensByBucketRow[] {
  return queryTokensByBucket(ctx.db, window);
}

export function getCacheByBucket(ctx: StoreCtx, window: BucketedWindow): CacheByBucketRow[] {
  return queryCacheByBucket(ctx.db, window);
}

export function getHaltDistribution(ctx: StoreCtx, window: AnalyticsWindow): HaltDistributionRow[] {
  return queryHaltDistribution(ctx.db, window);
}

export function getModelDistribution(ctx: StoreCtx, window: AnalyticsWindow): ModelDistributionRow[] {
  return queryModelDistribution(ctx.db, window);
}

export function getTopWorkflows(ctx: StoreCtx, window: AnalyticsWindow, limit: number): TopWorkflowRow[] {
  return queryTopWorkflows(ctx.db, window, limit);
}

export function getFirstRunAt(ctx: StoreCtx, window: AnalyticsWindow): number | null {
  return queryFirstRunAt(ctx.db, window);
}

export function getWorkflowDirectory(ctx: StoreCtx, opts: { cwd?: string }): WorkflowDirectoryRow[] {
  return queryWorkflowDirectory(ctx.db, opts);
}

export function getDrilldownPage(
  ctx: StoreCtx,
  filters: DrilldownFilters,
  opts: { limit: number; cursor?: string | undefined },
): DrilldownPage {
  return queryDrilldownPage(ctx.db, filters, opts);
}

export function getGlobalMetricsTotals(ctx: StoreCtx, opts: { sinceMs: number }): GlobalMetricsTotalsRow {
  return selectGlobalMetricsTotals(ctx.db, opts.sinceMs);
}

export function getGlobalModelBreakdown(ctx: StoreCtx, opts: { sinceMs: number }): GlobalModelBreakdownRow[] {
  return selectGlobalModelBreakdown(ctx.db, opts.sinceMs);
}
