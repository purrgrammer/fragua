// Cache reads vs writes per bucket. Reads = the win, writes = the
// invoice — keeping them stacked makes the read/write balance visible
// without a second chart.

import { Database } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
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
import { renderStackSegment } from "./chart-stack.tsx";
import { ANALYTICS_COLORS } from "./palette.ts";

// Stack order matches the Spend / Tokens convention so the same series
// sits in the same vertical position across all three charts: Cache
// write below, Cache read above. Colors come from the shared palette
// so the grays match exactly.
const CACHE_KEYS = ["cacheWriteTokens", "cacheReadTokens"] as const;
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
  cacheWriteTokens: { label: "Cache writes", color: ANALYTICS_COLORS.cacheWrite },
  cacheReadTokens: { label: "Cache reads", color: ANALYTICS_COLORS.cacheRead },
};

function rankOf(key: string): number {
  const idx = (CACHE_KEYS as readonly string[]).indexOf(key);
  return idx === -1 ? CACHE_KEYS.length : idx;
}

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
            itemSorter={(item) => rankOf(String(item.dataKey ?? ""))}
            content={
              <ChartTooltipContent
                indicator="dot"
                labelFormatter={(label) => formatBucketTooltip(Number(label), bucket, locale)}
                valueFormatter={(value) => formatTokensLong(Number(value))}
              />
            }
          />
          <ChartLegend
            content={({ payload: rawPayload, verticalAlign }) => (
              <ChartLegendContent
                payload={[...(rawPayload ?? [])].sort(
                  (a, b) => rankOf(String(a.dataKey ?? "")) - rankOf(String(b.dataKey ?? "")),
                )}
                verticalAlign={verticalAlign}
              />
            )}
          />
          {CACHE_KEYS.map((key) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="cache"
              fill={`var(--color-${key})`}
              shape={(barProps: unknown) => renderStackSegment<CacheKey>(barProps, CACHE_KEYS, key)}
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
