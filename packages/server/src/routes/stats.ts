// GET /stats — server-side aggregate across every run under `runsDir`.
//
// The Home dashboard could derive these numbers from `GET /pipelines`
// (and a fallback path in `web/src/lib/stats.ts` does exactly that),
// but two reasons push us to expose a server endpoint:
//
//   1. Truth across the full archive: `GET /pipelines` returns the
//      currently-rendered list (no pagination today, but the moment we
//      add it the client-side reducer will start lying about totals).
//   2. One pass over each run's events, server-side: cheap on disk,
//      avoids shipping every event payload back to the browser just so
//      it can re-fold what the server already had to read.
//
// No caching — short term, recomputing on every request is fine
// (handfuls of runs, milliseconds of replay). A TTL cache is a later
// task if it ever matters; the route stays a single async function so
// we can wrap it without changing the call sites.
//
// Reuses `deriveSummary` + `aggregateCost` so the wire shape stays in
// lockstep with what `GET /pipelines` rows would total to.

import { foldAll } from "@swarm/events";
import { Hono } from "hono";
import { summaryProjection } from "../lib/summary.ts";
import { type RunReader, sourceFromRunReader } from "../ports.ts";
import type { StatsPayload } from "../schemas.ts";

export interface StatsRouteOptions {
  runReader: RunReader;
}

interface StatsAccumulator {
  totalRuns: number;
  running: number;
  succeeded: number;
  failed: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  durationSum: number;
  durationCount: number;
}

export function statsRoutes(opts: StatsRouteOptions): Hono {
  const app = new Hono();

  app.get("/stats", async (c) => {
    const workflowFilter = c.req.query("workflow");
    // Adapt the route's RunReader into the canonical EventSource port so
    // we can use the Wave-5 `foldAll` helper — one replay per run,
    // cleanly delegated to `summaryProjection`. Avoids reimplementing
    // status / cost / duration for the Nth time.
    const source = sourceFromRunReader(opts.runReader);

    const init: StatsAccumulator = {
      totalRuns: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      durationSum: 0,
      durationCount: 0,
    };

    const acc = await foldAll(
      source,
      summaryProjection,
      (a, summary) => {
        // Workflow filter: compares against the same `workflowName` the
        // list rows show, so callers pass exactly what they see.
        if (workflowFilter !== undefined && summary.workflowName !== workflowFilter) return a;
        a.totalRuns += 1;
        if (summary.status === "running") a.running += 1;
        else if (summary.status === "success") a.succeeded += 1;
        else if (summary.status === "fail") a.failed += 1;
        a.totalCostUsd += summary.costUsd;
        a.totalInputTokens += summary.inputTokens;
        a.totalOutputTokens += summary.outputTokens;
        a.totalCacheReadTokens += summary.cacheReadTokens;
        a.totalCacheWriteTokens += summary.cacheWriteTokens;
        // Avg duration only counts terminal runs — a long-running pipeline
        // would otherwise drag the average toward "in progress" rather
        // than "how long do runs take".
        if ((summary.status === "success" || summary.status === "fail") && summary.durationMs !== undefined) {
          a.durationSum += summary.durationMs;
          a.durationCount += 1;
        }
        return a;
      },
      init,
    );

    const terminal = acc.succeeded + acc.failed;
    const successRate = terminal === 0 ? 0 : acc.succeeded / terminal;
    const payload: StatsPayload = {
      totalRuns: acc.totalRuns,
      running: acc.running,
      succeeded: acc.succeeded,
      failed: acc.failed,
      successRate,
      totalCostUsd: acc.totalCostUsd,
      totalInputTokens: acc.totalInputTokens,
      totalOutputTokens: acc.totalOutputTokens,
      totalCacheReadTokens: acc.totalCacheReadTokens,
      totalCacheWriteTokens: acc.totalCacheWriteTokens,
      ...(acc.durationCount > 0 ? { avgDurationMs: acc.durationSum / acc.durationCount } : {}),
      updatedAt: new Date().toISOString(),
    };
    return c.json(payload);
  });

  return app;
}
