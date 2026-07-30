// Pure reducer that turns a `RunSummary[]` into the numbers the
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
//   3. The source of truth for our parity tests in @fragua/server's
//      stats route — keeping the two implementations honest.

import type { RunSummary } from "./api.ts";
import { cacheHitRate } from "./cache-hit-rate.ts";

export interface DashboardStats {
  /** Total number of runs in the input. */
  totalRuns: number;
  /** Count of runs whose latest status is `"queued"` — waiting for a
   * concurrency slot. */
  queued: number;
  /** Count of runs whose latest status is `"running"` — actively
   * executing a node. */
  running: number;
  /** Count of runs whose latest status is `"paused"` — suspended at a
   * human-in-the-loop checkpoint, resumable. */
  paused: number;
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
  /** Sum of `inputTokens` across every input row — fresh prompt tokens. */
  totalInputTokens: number;
  /** Sum of `outputTokens` across every input row — generated tokens. */
  totalOutputTokens: number;
  /** Billed tokens — `totalInputTokens + totalOutputTokens +
   * totalCacheReadTokens + totalCacheWriteTokens`. The headline figure
   * the Tokens tile renders; matches `run_state.billed_tokens`,
   * pi-ai's `usage.totalTokens`, and the run's `total_cost_usd`. Budget
   * enforcement runs against fresh tokens only and lives in the
   * daemon executor — not surfaced here. */
  billedTokens: number;
  /** Sum of `cacheReadTokens` — prompt-cache hits across every run. */
  totalCacheReadTokens: number;
  /** Sum of `cacheWriteTokens` — cache priming across every run. */
  totalCacheWriteTokens: number;
  /**
   * Prompt-cache hit rate — see `lib/cache-hit-rate.ts` for the definition
   * and why cache writes are in the denominator while output tokens are not.
   * Undefined when there is nothing to divide.
   */
  cacheHitRate?: number;
  /**
   * Average `durationMs` over terminal runs only. Omitted (not zero)
   * when no terminal runs have a measurable duration — keeps the wire
   * shape consistent with `RunSummary.durationMs` and lets the UI
   * render "—" instead of a fake "0ms".
   */
  avgDurationMs?: number;
}

/** Fold a list of run summaries into one set of dashboard tiles. */
export function computeStats(runs: readonly RunSummary[]): DashboardStats {
  let queued = 0;
  let running = 0;
  let paused = 0;
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

  for (const p of runs) {
    if (p.status === "queued") queued += 1;
    else if (p.status === "running") running += 1;
    else if (p.status === "paused") paused += 1;
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
  // See lib/cache-hit-rate.ts for what this counts and why.
  const cacheHitRateValue = cacheHitRate({
    inputTokens: totalInputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheWriteTokens: totalCacheWriteTokens,
  });

  return {
    totalRuns: runs.length,
    queued,
    running,
    paused,
    succeeded,
    failed,
    canceled,
    successRate,
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
    billedTokens: totalInputTokens + totalOutputTokens + totalCacheReadTokens + totalCacheWriteTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    ...(cacheHitRateValue !== undefined ? { cacheHitRate: cacheHitRateValue } : {}),
    ...(durationCount > 0 ? { avgDurationMs: durationSum / durationCount } : {}),
  };
}
