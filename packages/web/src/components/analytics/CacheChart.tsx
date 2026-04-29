// Cache reads vs writes per bucket. Reads = the win, writes = the
// invoice — keeping them stacked makes the read/write balance visible
// without a second chart.

import { Database } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Rectangle, XAxis, YAxis } from "recharts";
import { formatTokensCompact, formatTokensLong, percentFormatOptions } from "@/lib/format";
import { formatBucketTick, formatBucketTooltip } from "@/lib/humanize";
import { useLocale } from "@/lib/locale";
import { useReducedMotion } from "@/lib/useReducedMotion";
import type { BucketKind, CacheBucketRow } from "@/types/analytics";
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

const CACHE_KEYS = ["cacheReadTokens", "cacheWriteTokens"] as const;
type CacheKey = (typeof CACHE_KEYS)[number];

export interface CacheChartProps {
  rows: readonly CacheBucketRow[];
  bucket: BucketKind;
  loading?: boolean;
  onSelectBucket?: (bucketMs: number) => void;
  /** Headline cache hit rate (0–1) + comparison baseline. */
  total: { current: number | undefined; previous: number | null };
}

const config: ChartConfig = {
  cacheReadTokens: { label: "Cache reads", color: "var(--sw-chart-pair-primary)" },
  cacheWriteTokens: { label: "Cache writes", color: "var(--sw-chart-pair-secondary)" },
};

export function CacheChart({ rows, bucket, loading, onSelectBucket, total }: CacheChartProps): JSX.Element {
  const locale = useLocale();
  const reduceMotion = useReducedMotion();
  const animMs = reduceMotion ? 0 : 250;
  const rowsTotal = rows.reduce((s, r) => s + r.cacheReadTokens + r.cacheWriteTokens, 0);

  return (
    <ChartCard
      title="Cache"
      icon={<Database className="size-4" />}
      headerRight={<ChartTotal current={total.current} previous={total.previous} format={percentFormatOptions()} />}
      loading={loading}
      empty={rowsTotal === 0 && !loading}
    >
      <ChartContainer config={config} className="size-full">
        <BarChart data={rows as CacheBucketRow[]} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
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
            tickFormatter={(v) => formatTokensCompact(Number(v))}
            tickLine={false}
            axisLine={false}
            stroke="var(--sw-muted)"
            fontSize={11}
            width={36}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                indicator="dot"
                labelFormatter={(label) => formatBucketTooltip(Number(label), bucket, locale)}
                valueFormatter={(value) => formatTokensLong(Number(value))}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          {CACHE_KEYS.map((key) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="cache"
              fill={`var(--color-${key})`}
              shape={(barProps: unknown) => {
                const p = barProps as { payload: CacheBucketRow };
                return (
                  <Rectangle
                    {...(barProps as React.ComponentProps<typeof Rectangle>)}
                    radius={visibleSegmentRadius<CacheKey>(p.payload, CACHE_KEYS, key)}
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
