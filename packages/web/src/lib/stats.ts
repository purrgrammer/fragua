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
  /**
   * `succeeded / (succeeded + failed)`. Returns 0 when there are no
   * terminal runs (preferred over NaN so callers can `formatPercent`
   * the value without a guard).
   */
  successRate: number;
  /** Sum of `costUsd` across every input row. */
  totalCostUsd: number;
  /** Sum of `inputTokens + outputTokens` across every input row. */
  totalTokens: number;
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
  let totalCostUsd = 0;
  let totalTokens = 0;
  let durationSum = 0;
  let durationCount = 0;

  for (const p of pipelines) {
    if (p.status === "running") running += 1;
    else if (p.status === "success") succeeded += 1;
    else if (p.status === "fail") failed += 1;

    totalCostUsd += p.costUsd;
    totalTokens += p.inputTokens + p.outputTokens;

    // Avg only over terminal runs — a long-running pipeline would
    // otherwise drag the average toward "in progress" rather than
    // "how long do runs take".
    if ((p.status === "success" || p.status === "fail") && p.durationMs !== undefined) {
      durationSum += p.durationMs;
      durationCount += 1;
    }
  }

  const terminal = succeeded + failed;
  const successRate = terminal === 0 ? 0 : succeeded / terminal;

  return {
    totalRuns: pipelines.length,
    running,
    succeeded,
    failed,
    successRate,
    totalCostUsd,
    totalTokens,
    ...(durationCount > 0 ? { avgDurationMs: durationSum / durationCount } : {}),
  };
}
