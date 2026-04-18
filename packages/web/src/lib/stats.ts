// Pure reducer that turns a `PipelineSummary[]` into the numbers the
// Home dashboard renders. Lives next to `format.ts` / `time.ts` so the
// "no inline number-crunching in JSX" discipline applies — components
// import the reducer; they never re-fold cost/duration themselves.
//
// There is also a server-side aggregate at `GET /stats` (P5.13) that
// computes the same thing across the entire run archive. This client
// reducer stays as:
//   1. The fallback when /stats is unavailable.
//   2. A projection over whatever subset of runs the page already has
//      (e.g. "stats over the most-recent 50 runs", which the server
//      can't easily express without a query parameter we don't need
//      yet).
//   3. The source of truth for our parity tests in @swarm/server's
//      stats route — keeping the two implementations honest.

import type { PipelineSummary } from "./api.ts";

export interface DashboardStats {
  /** Total number of runs in the input. */
  totalRuns: number;
  /** Count of runs whose latest status is `"running"`. */
  running: number;
  /** Count of runs whose latest status is `"success"`. */
  succeeded: number;
  /** Count of runs whose latest status is `"fail"`. */
  failed: number;
  /** Count of runs whose latest status is `"canceled"` — user-initiated
   * termination, excluded from `successRate`. */
  canceled: number;
  /**
   * `succeeded / (succeeded + failed)`. Returns 0 when there are no
   * terminal runs (preferred over NaN so callers can `formatPercent`
   * the value without a guard). Canceled runs are excluded from the
   * denominator — a user bailing out is neither a success nor a failure.
   */
  successRate: number;
  /** Sum of `costUsd` across every input row. */
  totalCostUsd: number;
  /** Sum of `inputTokens + outputTokens` across every input row. */
  totalTokens: number;
  /** Sum of `cacheReadTokens` — prompt-cache hits across every run. */
  totalCacheReadTokens: number;
  /** Sum of `cacheWriteTokens` — cache priming across every run. */
  totalCacheWriteTokens: number;
  /**
   * Prompt-cache hit rate: `totalCacheReadTokens / (totalInputTokens + totalCacheReadTokens)`.
   * Undefined when there's nothing to divide (no input tokens at all).
   * Fresh `inputTokens` excludes cache hits on providers that track
   * them separately (Anthropic), so this ratio approximates how much
   * of the read context came from cache.
   */
  cacheHitRate?: number;
  /**
   * Average `durationMs` over terminal runs only. Omitted (not zero)
   * when no terminal runs have a measurable duration — keeps the wire
   * shape consistent with `PipelineSummary.durationMs` and lets the UI
   * render "—" instead of a fake "0ms".
   */
  avgDurationMs?: number;
}

/** Fold a list of pipeline summaries into one set of dashboard tiles. */
export function computeStats(pipelines: readonly PipelineSummary[]): DashboardStats {
  let running = 0;
  let succeeded = 0;
  let failed = 0;
  let canceled = 0;
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let durationSum = 0;
  let durationCount = 0;

  for (const p of pipelines) {
    if (p.status === "running") running += 1;
    else if (p.status === "success") succeeded += 1;
    else if (p.status === "fail") failed += 1;
    else if (p.status === "canceled") canceled += 1;

    totalCostUsd += p.costUsd;
    totalInputTokens += p.inputTokens;
    totalOutputTokens += p.outputTokens;
    totalCacheReadTokens += p.cacheReadTokens ?? 0;
    totalCacheWriteTokens += p.cacheWriteTokens ?? 0;

    // Avg only over runs that ran to completion. Canceled runs are
    // excluded because they were cut short — including them would pull
    // the average toward "how long until someone got bored" rather than
    // "how long do runs take".
    if ((p.status === "success" || p.status === "fail") && p.durationMs !== undefined) {
      durationSum += p.durationMs;
      durationCount += 1;
    }
  }

  const terminal = succeeded + failed;
  const successRate = terminal === 0 ? 0 : succeeded / terminal;
  const readDenom = totalInputTokens + totalCacheReadTokens;
  const cacheHitRate = readDenom > 0 ? totalCacheReadTokens / readDenom : undefined;

  return {
    totalRuns: pipelines.length,
    running,
    succeeded,
    failed,
    canceled,
    successRate,
    totalCostUsd,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    ...(cacheHitRate !== undefined ? { cacheHitRate } : {}),
    ...(durationCount > 0 ? { avgDurationMs: durationSum / durationCount } : {}),
  };
}
