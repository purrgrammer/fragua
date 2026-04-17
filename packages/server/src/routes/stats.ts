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

import { aggregateCost } from "@swarm/events";
import { Hono } from "hono";
import { deriveStatus, deriveSummary, deriveWorkflowName } from "../lib/summary.ts";
import type { RunReader } from "../ports.ts";
import type { StatsPayload } from "../schemas.ts";

export interface StatsRouteOptions {
  runReader: RunReader;
}

export function statsRoutes(opts: StatsRouteOptions): Hono {
  const app = new Hono();

  app.get("/stats", async (c) => {
    const workflow = c.req.query("workflow");
    const ids = await opts.runReader.listRuns();

    let totalRuns = 0;
    let running = 0;
    let succeeded = 0;
    let failed = 0;
    let totalCostUsd = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let durationSum = 0;
    let durationCount = 0;

    for (const runId of ids) {
      const events = await opts.runReader.readEvents(runId);
      // Tolerate races with cleanup the same way /pipelines does.
      if (!events) continue;

      // Workflow filter: scaffolded but optional. We compare against the
      // same `deriveWorkflowName` output the list rows use, so callers
      // can pass exactly what they see in the UI.
      if (workflow !== undefined) {
        const first = events[0];
        if (!first) continue;
        const data = first.data as {
          workflow?: string;
          workflow_label?: string;
          workflow_path?: string;
          graph_id?: string;
        };
        const name = deriveWorkflowName(data, first.workflow_sha);
        if (name !== workflow) continue;
      }

      totalRuns += 1;
      const status = deriveStatus(events);
      if (status === "running") running += 1;
      else if (status === "success") succeeded += 1;
      else if (status === "fail") failed += 1;

      const totals = aggregateCost(events);
      totalCostUsd += totals.cost_usd;
      totalInputTokens += totals.input_tokens;
      totalOutputTokens += totals.output_tokens;

      // Avg duration only counts terminal runs — a long-running pipeline
      // would otherwise drag the average toward "in progress" rather
      // than "how long do runs take".
      if (status === "success" || status === "fail") {
        const summary = deriveSummary(runId, events);
        if (summary.durationMs !== undefined) {
          durationSum += summary.durationMs;
          durationCount += 1;
        }
      }
    }

    const terminal = succeeded + failed;
    const successRate = terminal === 0 ? 0 : succeeded / terminal;
    const payload: StatsPayload = {
      totalRuns,
      running,
      succeeded,
      failed,
      successRate,
      totalCostUsd,
      totalInputTokens,
      totalOutputTokens,
      ...(durationCount > 0 ? { avgDurationMs: durationSum / durationCount } : {}),
      updatedAt: new Date().toISOString(),
    };
    return c.json(payload);
  });

  return app;
}
