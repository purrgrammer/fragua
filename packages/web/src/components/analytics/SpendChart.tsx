// Bucketed spend over time, stacked input vs output USD. Cost split is
// sourced from `metrics.totalInputCostUsd` / `totalOutputCostUsd` —
// runs that pre-date the split show 0 in the components but still
// contribute to the total via `total_cost_usd`.

import { DollarSign } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Rectangle, XAxis, YAxis } from "recharts";
import { formatUsd, usdFormatOptions } from "@/lib/format";
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
import { visibleSegmentRadius } from "./chart-stack.ts";
import { ChartTotal } from "./ChartTotal.tsx";

const SPEND_KEYS = ["inputCostUsd", "outputCostUsd"] as const;
type SpendKey = (typeof SPEND_KEYS)[number];

export interface SpendChartProps {
  rows: readonly SpendBucketRow[];
  bucket: BucketKind;
  loading?: boolean;
  onSelectBucket?: (bucketMs: number) => void;
  /** Headline total + comparison baseline rendered in the card header. */
  total: { current: number | undefined; previous: number | null };
}

const config: ChartConfig = {
  inputCostUsd: { label: "Input", color: "var(--sw-chart-pair-primary)" },
  outputCostUsd: { label: "Output", color: "var(--sw-chart-pair-secondary)" },
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
                valueFormatter={(value) => formatUsd(Number(value))}
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
