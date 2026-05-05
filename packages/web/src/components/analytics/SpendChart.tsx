// Bucketed spend over time, stacked across the four token buckets
// (input / cache write / cache read / output USD). Sourced from the
// reducer-projected `metrics.total{Input,Output,CacheRead,CacheWrite}CostUsd`.
// Runs that pre-date a given split fall back to a token-share approximation
// of `total_cost_usd` so the bar isn't empty (see analytics-queries).

import { DollarSign } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Rectangle, XAxis, YAxis } from "recharts";
import { formatUsd, pickSharedUsdOptions, usdFormatOptions } from "@/lib/format";
import { formatBucketTick, formatBucketTooltip } from "@/lib/humanize";
import { useLocale } from "@/lib/locale";
import { useReducedMotion } from "@/lib/useReducedMotion";
import type { BucketKind, SpendBucketRow } from "@/types/analytics";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "../ui/chart.tsx";
import { ChartCard } from "./ChartCard.tsx";
import { ChartTotal } from "./ChartTotal.tsx";
import { visibleSegmentRadius } from "./chart-stack.ts";

// Stack order = bar order from bottom to top: Input · Cache write ·
// Cache read · Output. Mirrors the per-step popover's row order so
// operators read both surfaces with the same vocabulary.
const SPEND_KEYS = ["inputCostUsd", "cacheWriteCostUsd", "cacheReadCostUsd", "outputCostUsd"] as const;
type SpendKey = (typeof SPEND_KEYS)[number];

export interface SpendChartProps {
  rows: readonly SpendBucketRow[];
  bucket: BucketKind;
  loading?: boolean;
  onSelectBucket?: (bucketMs: number) => void;
  /** Headline total + comparison baseline rendered in the card header. */
  total: { current: number | undefined; previous: number | null };
}

// Input + Output get the two strong tones (sw-chart-1 / sw-chart-2);
// cache write + cache read get the softer ones (sw-chart-3 / sw-chart-4).
// Reads as "real work" (input/output) framing the cache layer, with
// cache_read as the lightest segment since it's the discounted bucket.
const config: ChartConfig = {
  inputCostUsd: { label: "Input", color: "var(--sw-chart-1)" },
  cacheWriteCostUsd: { label: "Cache write", color: "var(--sw-chart-3)" },
  cacheReadCostUsd: { label: "Cache read", color: "var(--sw-chart-4)" },
  outputCostUsd: { label: "Output", color: "var(--sw-chart-2)" },
};

function rankOf(key: string): number {
  const idx = (SPEND_KEYS as readonly string[]).indexOf(key);
  return idx === -1 ? SPEND_KEYS.length : idx;
}

export function SpendChart({ rows, bucket, loading, onSelectBucket, total }: SpendChartProps): JSX.Element {
  const locale = useLocale();
  const reduceMotion = useReducedMotion();
  const animMs = reduceMotion ? 0 : 250;
  const rowsTotal = rows.reduce((s, r) => s + r.costUsd, 0);

  return (
    <ChartCard
      title="Spend"
      icon={<DollarSign className="size-4" />}
      headerRight={
        <ChartTotal current={total.current} previous={total.previous} format={usdFormatOptions(total.current ?? 0)} />
      }
      loading={loading}
      empty={rowsTotal === 0 && !loading}
    >
      <ChartContainer config={config} className="size-full">
        <BarChart data={rows as SpendBucketRow[]} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--sw-border)" />
          <XAxis
            dataKey="bucket"
            tickFormatter={(v) => formatBucketTick(Number(v), bucket, locale)}
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            stroke="var(--sw-muted)"
            fontSize={11}
          />
          <YAxis
            tickFormatter={(v) => formatUsd(Number(v))}
            tickLine={false}
            axisLine={false}
            stroke="var(--sw-muted)"
            fontSize={11}
            width={48}
          />
          <ChartTooltip
            cursor={false}
            itemSorter={(item) => rankOf(String(item.dataKey ?? ""))}
            content={
              <ChartTooltipContent
                indicator="dot"
                labelFormatter={(label) => formatBucketTooltip(Number(label), bucket, locale)}
                valueFormatter={(value, _name, payload) => {
                  // Align fraction-digit precision across the four bucket
                  // rows in the hovered slice so decimals line up — same
                  // rationale as the per-step popover. Cache_read at
                  // $0.0003 forces 4 digits; Input + Output then render
                  // at 4 digits too instead of 2.
                  //
                  // Recharts passes `item.payload` here (the data row
                  // directly — `{ bucket, costUsd, inputCostUsd, ... }`),
                  // not a wrapper. Cast straight to SpendBucketRow.
                  const slice = payload as SpendBucketRow | undefined;
                  const sharedOpts = slice ? pickSharedUsdOptions(SPEND_KEYS.map((k) => slice[k])) : undefined;
                  return formatUsd(Number(value), sharedOpts ? { intlOptions: sharedOpts } : {});
                }}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} className="-translate-y-1 justify-center gap-3" />
          {SPEND_KEYS.map((key) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="spend"
              fill={`var(--color-${key})`}
              shape={(barProps: unknown) => {
                const p = barProps as { payload: SpendBucketRow };
                return (
                  <Rectangle
                    {...(barProps as React.ComponentProps<typeof Rectangle>)}
                    radius={visibleSegmentRadius<SpendKey>(p.payload, SPEND_KEYS, key)}
                  />
                );
              }}
              animationDuration={animMs}
              animationEasing="ease-out"
              onClick={
                onSelectBucket ? (data) => onSelectBucket(Number((data as { bucket?: unknown }).bucket)) : undefined
              }
              cursor={onSelectBucket ? "pointer" : undefined}
            />
          ))}
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}
