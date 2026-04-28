// Bucketed spend over time. One bar per bucket; tooltip carries
// formatted USD. Click → drawer for that bucket.

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { formatUsd } from "@/lib/format";
import { formatBucketTick, formatBucketTooltip } from "@/lib/humanize";
import { useLocale } from "@/lib/locale";
import { useReducedMotion } from "@/lib/useReducedMotion";
import type { BucketKind, SpendBucketRow } from "@/types/analytics";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart.tsx";
import { ChartCard } from "./ChartCard.tsx";

export interface SpendChartProps {
  rows: readonly SpendBucketRow[];
  bucket: BucketKind;
  loading?: boolean;
  onSelectBucket?: (bucketMs: number) => void;
}

const config: ChartConfig = {
  costUsd: { label: "Spend", color: "var(--sw-accent-warn)" },
};

export function SpendChart({ rows, bucket, loading, onSelectBucket }: SpendChartProps): JSX.Element {
  const locale = useLocale();
  const reduceMotion = useReducedMotion();
  const animMs = reduceMotion ? 0 : 250;
  const total = rows.reduce((s, r) => s + r.costUsd, 0);

  return (
    <ChartCard title="Spend" caption="USD per bucket" loading={loading} empty={total === 0 && !loading}>
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
            cursor={{ fill: "var(--sw-surface)" }}
            content={
              <ChartTooltipContent
                labelFormatter={(label) => formatBucketTooltip(Number(label), bucket, locale)}
                valueFormatter={(value) => formatUsd(Number(value))}
              />
            }
          />
          <Bar
            dataKey="costUsd"
            fill="var(--color-costUsd)"
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
