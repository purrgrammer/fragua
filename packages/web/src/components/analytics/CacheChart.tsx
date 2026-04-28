// Cache reads vs writes per bucket. Reads = the win, writes = the
// invoice — keeping them stacked makes the read/write balance visible
// without a second chart.

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { formatTokensCompact, formatTokensLong } from "@/lib/format";
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

export interface CacheChartProps {
  rows: readonly CacheBucketRow[];
  bucket: BucketKind;
  loading?: boolean;
  onSelectBucket?: (bucketMs: number) => void;
}

const config: ChartConfig = {
  cacheReadTokens: { label: "Cache reads", color: "var(--sw-accent-success)" },
  cacheWriteTokens: { label: "Cache writes", color: "var(--sw-accent-warn)" },
};

export function CacheChart({ rows, bucket, loading, onSelectBucket }: CacheChartProps): JSX.Element {
  const locale = useLocale();
  const reduceMotion = useReducedMotion();
  const animMs = reduceMotion ? 0 : 250;
  const total = rows.reduce((s, r) => s + r.cacheReadTokens + r.cacheWriteTokens, 0);

  return (
    <ChartCard title="Cache" caption="reads vs writes" loading={loading} empty={total === 0 && !loading}>
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
                indicator="dashed"
                labelFormatter={(label) => formatBucketTooltip(Number(label), bucket, locale)}
                valueFormatter={(value) => formatTokensLong(Number(value))}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar
            dataKey="cacheReadTokens"
            fill="var(--color-cacheReadTokens)"
            radius={4}
            animationDuration={animMs}
            animationEasing="ease-out"
            onClick={
              onSelectBucket ? (data) => onSelectBucket(Number((data as { bucket?: unknown }).bucket)) : undefined
            }
            cursor={onSelectBucket ? "pointer" : undefined}
          />
          <Bar
            dataKey="cacheWriteTokens"
            fill="var(--color-cacheWriteTokens)"
            radius={4}
            animationDuration={animMs}
            animationEasing="ease-out"
            onClick={
              onSelectBucket ? (data) => onSelectBucket(Number((data as { bucket?: unknown }).bucket)) : undefined
            }
            cursor={onSelectBucket ? "pointer" : undefined}
          />
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}
