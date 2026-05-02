// Analytics dashboard endpoints.
//
// Two routes:
//   GET /analytics       — single batch payload for the /analytics page.
//                          Returns KPI totals (current + optional previous
//                          window), bucketed time series (runs, spend,
//                          tokens, cache), and three distributions
//                          (halt-reason, model, top workflows). One round
//                          trip per refresh tick.
//   GET /analytics/runs  — drill-down. Returns a paginated list of
//                          RunSummary objects matching the same window +
//                          chart-element filters (workflow, halt, model).
//                          Reuses the runs-adapter projection so the UI
//                          renders these with the same RunRow component
//                          the /runs page uses.

import {
  type AnalyticsWindow,
  type BucketedWindow,
  type BucketKind,
  type DrilldownFilters,
  decodeCursor,
  type IEventStore,
} from "@swarm/store";
import { Hono } from "hono";
import type { WorkflowReader } from "../ports.ts";
import { runStateToSummary } from "./runs-adapter.ts";

export interface AnalyticsRoutesOpts {
  store: IEventStore;
  workflowReader?: WorkflowReader;
}

const TOP_WORKFLOWS_LIMIT = 8;
const DRILLDOWN_DEFAULT_LIMIT = 30;
const DRILLDOWN_MAX_LIMIT = 100;
const VALID_BUCKETS: ReadonlySet<BucketKind> = new Set(["hour", "day", "month"]);

export function analyticsRoutes(opts: AnalyticsRoutesOpts): Hono {
  const app = new Hono();
  const { store } = opts;

  app.get("/analytics", (c) => {
    const params = parseAnalyticsParams(c.req.query());
    if (!params.ok) return c.json({ error: params.error, code: "bad_request" }, 400);

    const { current, previous, bucket, tzOffsetMinutes } = params;
    const bucketed: BucketedWindow = { ...current, bucket, tzOffsetMinutes };

    const totals = {
      current: store.getKpiTotals(current),
      previous: previous ? store.getKpiTotals(previous) : null,
    };

    return c.json({
      window: { fromMs: current.fromMs, toMs: current.toMs, bucket, tzOffsetMinutes },
      compareWindow: previous ? { fromMs: previous.fromMs, toMs: previous.toMs } : null,
      totals,
      // No zero-fill — empty buckets are omitted entirely. The chart's
      // x-axis compresses to only the buckets SQL actually returned, so
      // a quiet stretch shows as a missing tick rather than a 0-height
      // bar. Drill-down still works since each row carries its own
      // bucket-ms.
      runsByBucket: store.getRunsByBucket(bucketed),
      spendByBucket: store.getSpendByBucket(bucketed),
      tokensByBucket: store.getTokensByBucket(bucketed),
      cacheByBucket: store.getCacheByBucket(bucketed),
      haltDistribution: store.getHaltDistribution(current),
      modelDistribution: store.getModelDistribution(current),
      topWorkflows: store.getTopWorkflows(current, TOP_WORKFLOWS_LIMIT),
    });
  });

  app.get("/analytics/runs", async (c) => {
    const window = parseWindow(c.req.query());
    if (!window.ok) return c.json({ error: window.error, code: "bad_request" }, 400);

    const limit = clampDrilldownLimit(c.req.query("limit"));
    const cursor = c.req.query("cursor");
    const workflowSha = c.req.query("workflow");
    const haltCategory = c.req.query("halt");
    const model = c.req.query("model");

    const filterArgs: DrilldownFilters = {
      fromMs: window.fromMs,
      toMs: window.toMs,
    };
    if (workflowSha) filterArgs.workflowSha = workflowSha;
    if (haltCategory) filterArgs.haltCategory = haltCategory;
    if (model) filterArgs.model = model;

    const pageOpts: { limit: number; cursor?: string } = { limit };
    if (cursor && decodeCursor(cursor) !== null) pageOpts.cursor = cursor;

    const page = store.getDrilldownPage(filterArgs, pageOpts);

    // Hydrate RunSummary[] for the wire. Mirrors what `/runs` does so the
    // drawer can render with the same RunRow primitive. The events fetch
    // stays in this loop (per-run) — the drill-down page is bounded
    // (≤ 100) so the cost is manageable. If this becomes hot, fold the
    // summary-side fields the row needs into a dedicated SQL projection.
    const summaries = [];
    for (const runId of page.runIds) {
      const state = store.getState(runId);
      if (state == null) continue;
      const events = store.getEvents(runId, { limit: 5000 });
      const wf = store.getWorkflow(state.workflowSha);
      summaries.push(runStateToSummary(state, events, wf?.name));
    }

    return c.json({ runs: summaries, nextCursor: page.nextCursor });
  });

  return app;
}

// ── Query-string parsing ───────────────────────────────────────────────

interface AnalyticsParamsOk {
  ok: true;
  current: AnalyticsWindow;
  previous: AnalyticsWindow | null;
  bucket: BucketKind;
  tzOffsetMinutes: number;
}

interface ParseError {
  ok: false;
  error: string;
}

function parseAnalyticsParams(q: Record<string, string>): AnalyticsParamsOk | ParseError {
  const fromMs = Number(q["from"]);
  const toMs = Number(q["to"]);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return { ok: false, error: "from and to (unix ms) are required" };
  }
  if (toMs <= fromMs) {
    return { ok: false, error: "to must be greater than from" };
  }
  const bucketRaw = q["bucket"];
  if (!bucketRaw || !VALID_BUCKETS.has(bucketRaw as BucketKind)) {
    return { ok: false, error: `bucket must be one of: ${[...VALID_BUCKETS].join(", ")}` };
  }
  const tzOffsetMinutes = Number(q["tzOffsetMinutes"] ?? "0");
  if (!Number.isFinite(tzOffsetMinutes)) {
    return { ok: false, error: "tzOffsetMinutes must be a number" };
  }

  const compareFromRaw = q["compareFrom"];
  const compareToRaw = q["compareTo"];
  let previous: AnalyticsWindow | null = null;
  if (compareFromRaw !== undefined && compareToRaw !== undefined) {
    const compareFromMs = Number(compareFromRaw);
    const compareToMs = Number(compareToRaw);
    if (!Number.isFinite(compareFromMs) || !Number.isFinite(compareToMs) || compareToMs <= compareFromMs) {
      return { ok: false, error: "compareFrom/compareTo malformed" };
    }
    previous = { fromMs: compareFromMs, toMs: compareToMs };
  }

  return {
    ok: true,
    current: { fromMs, toMs },
    previous,
    bucket: bucketRaw as BucketKind,
    tzOffsetMinutes,
  };
}

interface WindowOk extends AnalyticsWindow {
  ok: true;
}

function parseWindow(q: Record<string, string>): WindowOk | ParseError {
  const fromMs = Number(q["from"]);
  const toMs = Number(q["to"]);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return { ok: false, error: "from and to (unix ms) are required" };
  }
  if (toMs <= fromMs) {
    return { ok: false, error: "to must be greater than from" };
  }
  return { ok: true, fromMs, toMs };
}

function clampDrilldownLimit(raw: string | undefined): number {
  if (raw === undefined) return DRILLDOWN_DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DRILLDOWN_DEFAULT_LIMIT;
  return Math.min(Math.floor(n), DRILLDOWN_MAX_LIMIT);
}
