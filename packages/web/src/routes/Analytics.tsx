// /analytics — operational dashboard for runs, spend, tokens, cache,
// and outcomes over a selectable time window.
//
// Layout:
//   ┌──────────────────────────────────────────────┐
//   │ Title                       [Window selector]│
//   ├────────────────────┬─────────────────────────┤
//   │ Runs (header+chart)│ Spend (header+chart)    │
//   ├────────────────────┼─────────────────────────┤
//   │ Tokens             │ Cache                   │
//   ├──────────┬─────────┴─────────────────────────┤
//   │ Outcomes │ Models  │ Top workflows           │
//   └──────────┴─────────┴─────────────────────────┘
//
// Each metric card carries its total + delta in the header next to the
// icon/title; clicking a bar opens the drill-down drawer scoped to the
// clicked slice. The drawer reuses RunRow.compact.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { CacheChart } from "../components/analytics/CacheChart.tsx";
import { DrillDownDrawer } from "../components/analytics/DrillDownDrawer.tsx";
// ProjectSelector intentionally absent: the project↔workflow filter
// interactions (auto-pin on local pick, auto-clear on project unpick)
// were subtle enough to defer. The server still accepts `?cwd=` and
// the WorkflowSelector still threads the local's owning cwd through
// the request — picking `Local · swarm:research` scopes everything to
// `swarm` implicitly. A separate, deliberate ProjectSelector
// integration is a follow-up.
// import { HaltDonut } from "../components/analytics/HaltDonut.tsx";
// import { ModelDonut } from "../components/analytics/ModelDonut.tsx";
import { RunsChart } from "../components/analytics/RunsChart.tsx";
import { SpendChart } from "../components/analytics/SpendChart.tsx";
import { TokensChart } from "../components/analytics/TokensChart.tsx";
// import { TopWorkflowsBar } from "../components/analytics/TopWorkflowsBar.tsx";
import { filterWindowOptions, WindowSelector } from "../components/analytics/WindowSelector.tsx";
import { type WorkflowSelection, WorkflowSelector } from "../components/analytics/WorkflowSelector.tsx";
import { resolveWindow, type WindowKey } from "../lib/analytics.ts";
import type { AnalyticsRequest } from "../lib/api.ts";
import { categoryLabel, formatBucketTooltip } from "../lib/humanize.ts";
import { useLocale } from "../lib/locale.ts";
import { queries } from "../lib/queries.ts";
import { useNow } from "../lib/useNow.ts";
import type { AnalyticsTotals, DrillSlice } from "../types/analytics.ts";

export function Analytics(): JSX.Element {
  const [windowKey, setWindowKey] = useState<WindowKey>("today");
  const [workflow, setWorkflow] = useState<WorkflowSelection | null>(null);
  // Effective cwd is derived from the workflow selection — locals
  // carry their owning project root; globals contribute none. The
  // WorkflowSelector reads it to switch between "show all locals
  // grouped per-project" and "show this project's locals flat."
  const effectiveCwd = workflow?.scope === "local" ? workflow.cwd : null;
  // Recompute the resolved window every minute so "Today" naturally
  // grows toward midnight without forcing a refetch on every render.
  // The actual chart refresh is driven by the 30s `refetchInterval`
  // on the analytics summary query.
  const now = useNow(60_000, true);
  const resolved = useMemo(() => resolveWindow(windowKey, new Date(now)), [windowKey, now]);

  const summaryReq: AnalyticsRequest = {
    fromMs: resolved.fromMs,
    toMs: resolved.toMs,
    bucket: resolved.bucket,
    tzOffsetMinutes: resolved.tzOffsetMinutes,
    compareFromMs: resolved.compareFromMs,
    compareToMs: resolved.compareToMs,
  };
  if (effectiveCwd) summaryReq.cwd = effectiveCwd;
  if (workflow) {
    summaryReq.workflowScope = workflow.scope;
    summaryReq.workflowName = workflow.name;
  }
  const { data, isPending } = useQuery(queries.analytics.summary(summaryReq));

  // When the data span narrows (e.g. a workflow filter is applied that
  // has fewer days of history), the current windowKey may no longer be
  // available. Fall back to 'all' so the selector never shows a hidden
  // option as the active value.
  const availableKeys = useMemo(
    () => new Set(filterWindowOptions(data?.firstRunAt ?? null, now).map((w) => w.key)),
    [data?.firstRunAt, now],
  );
  useEffect(() => {
    if (data !== undefined && !availableKeys.has(windowKey)) {
      setWindowKey("all");
    }
  }, [availableKeys, windowKey, data]);

  const [slice, setSlice] = useState<DrillSlice | null>(null);
  const locale = useLocale();

  const current = data?.totals.current ?? null;
  const previous = data?.totals.previous ?? null;
  const runsTotal = { current: current?.runs, previous: previous?.runs ?? null };
  const spendTotal = { current: current?.costUsd, previous: previous?.costUsd ?? null };
  // Headline = billed (input + output + cache_read + cache_write).
  // Matches `run_state.billed_tokens` and the per-run Tokens tile;
  // the chart bars carry the bucket breakdown.
  const tokensTotal = {
    current: current
      ? current.inputTokens + current.outputTokens + current.cacheReadTokens + current.cacheWriteTokens
      : undefined,
    previous: previous
      ? previous.inputTokens + previous.outputTokens + previous.cacheReadTokens + previous.cacheWriteTokens
      : null,
  };
  const cacheTotal = {
    current: cacheHitRate(current) ?? undefined,
    previous: cacheHitRate(previous),
  };

  // Build a slice from a clicked time bucket. The bucket spans
  // [bucketMs, bucketMs + bucketWidth); the drawer query uses the same
  // semantics.
  function openBucketSlice(bucketMs: number, label: string) {
    const next = nextBucketStart(bucketMs, resolved.bucket);
    const slice: DrillSlice = {
      fromMs: bucketMs,
      toMs: Math.min(next, resolved.toMs),
      title: `${label} · ${formatBucketTooltip(bucketMs, resolved.bucket, locale)}`,
    };
    if (effectiveCwd) slice.cwd = effectiveCwd;
    if (workflow) {
      slice.workflowScope = workflow.scope;
      slice.workflowName = workflow.name;
    }
    setSlice(slice);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end gap-2">
        <WorkflowSelector value={workflow} onChange={setWorkflow} cwd={effectiveCwd} />
        <WindowSelector value={windowKey} onChange={setWindowKey} firstRunMs={data?.firstRunAt ?? null} />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <RunsChart
          rows={data?.runsByBucket ?? []}
          bucket={resolved.bucket}
          loading={isPending}
          onSelectSlice={(b, category) => {
            const next = nextBucketStart(b, resolved.bucket);
            const slice: DrillSlice = {
              fromMs: b,
              toMs: Math.min(next, resolved.toMs),
              haltCategory: category,
              haltLabel: categoryLabel(category),
              title: `Runs · ${categoryLabel(category)} · ${formatBucketTooltip(b, resolved.bucket, locale)}`,
            };
            if (effectiveCwd) slice.cwd = effectiveCwd;
            if (workflow) {
              slice.workflowScope = workflow.scope;
              slice.workflowName = workflow.name;
            }
            setSlice(slice);
          }}
          total={runsTotal}
        />
        <SpendChart
          rows={data?.spendByBucket ?? []}
          bucket={resolved.bucket}
          loading={isPending}
          onSelectBucket={(b) => openBucketSlice(b, "Spend")}
          total={spendTotal}
        />
        <TokensChart
          rows={data?.tokensByBucket ?? []}
          bucket={resolved.bucket}
          loading={isPending}
          onSelectBucket={(b) => openBucketSlice(b, "Tokens")}
          total={tokensTotal}
        />
        <CacheChart
          rows={data?.cacheByBucket ?? []}
          bucket={resolved.bucket}
          loading={isPending}
          onSelectBucket={(b) => openBucketSlice(b, "Cache")}
          total={cacheTotal}
        />
      </div>

      {/* Outcomes (HaltDonut), Models (ModelDonut), and Top workflows hidden
          pending more thinking + visual work. Restore `lg:grid-cols-2` on the
          outcomes/models wrapper when re-enabling both donuts. Re-add `windowDef`
          (was `WINDOWS.find(...) ?? WINDOWS[0]!`) when bringing these back —
          the title strings depend on it.

      <div className="grid grid-cols-1 gap-3">
        <HaltDonut
          rows={data?.haltDistribution ?? []}
          loading={isPending}
          onSelectCategory={(category, label) =>
            setSlice({
              fromMs: resolved.fromMs,
              toMs: resolved.toMs,
              haltCategory: category,
              haltLabel: label,
              title: `${label} · ${windowDef.label.toLowerCase()}`,
            })
          }
        />
        <ModelDonut
          rows={data?.modelDistribution ?? []}
          loading={isPending}
          onSelectModel={(model, label) =>
            setSlice({
              fromMs: resolved.fromMs,
              toMs: resolved.toMs,
              model,
              title: `${label} · ${windowDef.label.toLowerCase()}`,
            })
          }
        />
      </div>

      <TopWorkflowsBar
        rows={data?.topWorkflows ?? []}
        loading={isPending}
        onSelectWorkflow={(sha, label) =>
          setSlice({
            fromMs: resolved.fromMs,
            toMs: resolved.toMs,
            workflowSha: sha,
            workflowName: label,
            title: `${label} · ${windowDef.label.toLowerCase()}`,
          })
        }
      />
      */}

      <DrillDownDrawer slice={slice} onOpenChange={(open) => (open ? null : setSlice(null))} />
    </div>
  );
}

function cacheHitRate(totals: AnalyticsTotals | null): number | null {
  if (!totals) return null;
  // Include cacheWrite — see lib/format.ts formatCacheHitRate for rationale.
  // Without it the rate collapses to ~100% in any run with a warm cache.
  const denom = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  if (!Number.isFinite(denom) || denom <= 0) return null;
  return totals.cacheReadTokens / denom;
}

function nextBucketStart(bucketMs: number, bucket: "hour" | "day" | "month"): number {
  const d = new Date(bucketMs);
  if (bucket === "hour") {
    d.setHours(d.getHours() + 1);
    return d.getTime();
  }
  if (bucket === "day") {
    d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  d.setMonth(d.getMonth() + 1);
  return d.getTime();
}
