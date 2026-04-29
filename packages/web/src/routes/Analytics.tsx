// /analytics — operational dashboard for runs, spend, tokens, cache,
// and outcomes over a selectable time window.
//
// Layout:
//   ┌──────────────────────────────────────────────┐
//   │ Title                       [Window selector]│
//   ├──────────────────────────────────────────────┤
//   │ KPI · KPI · KPI · KPI                        │
//   ├────────────────────┬─────────────────────────┤
//   │ Runs (stacked bar) │ Spend (bar)             │
//   ├────────────────────┼─────────────────────────┤
//   │ Tokens (stacked)   │ Cache (stacked)         │
//   ├──────────┬─────────┴─────────────────────────┤
//   │ Outcomes │ Models  │ Top workflows           │
//   └──────────┴─────────┴─────────────────────────┘
//
// All charts are wired with onClick callbacks that open the drill-down
// drawer scoped to the clicked slice. The drawer reuses RunRow.compact.

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { CacheChart } from "../components/analytics/CacheChart.tsx";
import { DrillDownDrawer } from "../components/analytics/DrillDownDrawer.tsx";
import { HaltDonut } from "../components/analytics/HaltDonut.tsx";
import { KpiTilesRow } from "../components/analytics/KpiTilesRow.tsx";
import { ModelDonut } from "../components/analytics/ModelDonut.tsx";
import { RunsChart } from "../components/analytics/RunsChart.tsx";
import { SpendChart } from "../components/analytics/SpendChart.tsx";
import { TokensChart } from "../components/analytics/TokensChart.tsx";
import { TopWorkflowsBar } from "../components/analytics/TopWorkflowsBar.tsx";
import { WindowSelector } from "../components/analytics/WindowSelector.tsx";
import { resolveWindow, WINDOWS, type WindowKey } from "../lib/analytics.ts";
import { formatBucketTooltip } from "../lib/humanize.ts";
import { useLocale } from "../lib/locale.ts";
import { queries } from "../lib/queries.ts";
import { useNow } from "../lib/useNow.ts";
import type { DrillSlice } from "../types/analytics.ts";

export function Analytics(): JSX.Element {
  const [windowKey, setWindowKey] = useState<WindowKey>("today");
  // Recompute the resolved window every minute so "Today" naturally
  // grows toward midnight without forcing a refetch on every render.
  // The actual chart refresh is driven by the 30s `refetchInterval`
  // on the analytics summary query.
  const now = useNow(60_000, true);
  const resolved = useMemo(() => resolveWindow(windowKey, new Date(now)), [windowKey, now]);
  const windowDef = WINDOWS.find((w) => w.key === windowKey) ?? WINDOWS[0]!;

  const { data, isPending } = useQuery(
    queries.analytics.summary({
      fromMs: resolved.fromMs,
      toMs: resolved.toMs,
      bucket: resolved.bucket,
      tzOffsetMinutes: resolved.tzOffsetMinutes,
      compareFromMs: resolved.compareFromMs,
      compareToMs: resolved.compareToMs,
    }),
  );

  const [slice, setSlice] = useState<DrillSlice | null>(null);
  const locale = useLocale();

  // Build a slice from a clicked time bucket. The bucket spans
  // [bucketMs, bucketMs + bucketWidth); the drawer query uses the same
  // semantics.
  function openBucketSlice(bucketMs: number, label: string) {
    const next = nextBucketStart(bucketMs, resolved.bucket);
    setSlice({
      fromMs: bucketMs,
      toMs: Math.min(next, resolved.toMs),
      title: `${label} · ${formatBucketTooltip(bucketMs, resolved.bucket, locale)}`,
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <WindowSelector value={windowKey} onChange={setWindowKey} />
      </div>

      <KpiTilesRow current={data?.totals.current ?? EMPTY_TOTALS} previous={data?.totals.previous ?? null} />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <RunsChart
          rows={data?.runsByBucket ?? []}
          bucket={resolved.bucket}
          loading={isPending}
          onSelectBucket={(b) => openBucketSlice(b, "Runs")}
        />
        <SpendChart
          rows={data?.spendByBucket ?? []}
          bucket={resolved.bucket}
          loading={isPending}
          onSelectBucket={(b) => openBucketSlice(b, "Spend")}
        />
        <TokensChart
          rows={data?.tokensByBucket ?? []}
          bucket={resolved.bucket}
          loading={isPending}
          onSelectBucket={(b) => openBucketSlice(b, "Tokens")}
        />
        <CacheChart
          rows={data?.cacheByBucket ?? []}
          bucket={resolved.bucket}
          loading={isPending}
          onSelectBucket={(b) => openBucketSlice(b, "Cache")}
        />
      </div>

      {/* 4-col grid so the horizontal-bar Top Workflows chart gets a 2-col
          slot — with only ~1/3 page width the workflow labels truncated
          and the bars had no room to differentiate. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
        <HaltDonut
          rows={data?.haltDistribution ?? []}
          loading={isPending}
          onSelectStatus={(status, label) =>
            setSlice({
              fromMs: resolved.fromMs,
              toMs: resolved.toMs,
              haltCategory: status,
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
        <div className="lg:col-span-2">
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
        </div>
      </div>

      <DrillDownDrawer slice={slice} onOpenChange={(open) => (open ? null : setSlice(null))} />
    </div>
  );
}

const EMPTY_TOTALS = {
  runs: 0,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

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
