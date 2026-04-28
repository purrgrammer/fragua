// Bucketed runs over time, stacked by outcome (success / fail / other).
// Click a bar → drawer scoped to that bucket's runs.
//
// Colours come from `--sw-accent-success` / `--sw-accent-error` /
// `--sw-accent-idle` so the chart shares the palette used everywhere
// else for these states.

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { formatBucketTick, formatBucketTooltip } from "@/lib/humanize";
import { useLocale } from "@/lib/locale";
import { useReducedMotion } from "@/lib/useReducedMotion";
import type { BucketKind, RunsBucketRow } from "@/types/analytics";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "../ui/chart.tsx";
import { ChartCard } from "./ChartCard.tsx";

export interface RunsChartProps {
  rows: readonly RunsBucketRow[];
  bucket: BucketKind;
  loading?: boolean;
  onSelectBucket?: (bucketMs: number) => void;
}

const config: ChartConfig = {
  success: { label: "Success", color: "var(--sw-accent-success)" },
  fail: { label: "Failure", color: "var(--sw-accent-error)" },
  other: { label: "Other", color: "var(--sw-accent-idle)" },
};

export function RunsChart({ rows, bucket, loading, onSelectBucket }: RunsChartProps): JSX.Element {
  const locale = useLocale();
  const reduceMotion = useReducedMotion();
  const animMs = reduceMotion ? 0 : 250;
  const total = rows.reduce((s, r) => s + r.success + r.fail + r.other, 0);

  return (
    <ChartCard title="Runs" caption="success vs failure" loading={loading} empty={total === 0 && !loading}>
      <ChartContainer config={config} className="size-full">
        <BarChart data={rows as RunsBucketRow[]} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
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
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            stroke="var(--sw-muted)"
            fontSize={11}
            width={28}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                indicator="dashed"
                labelFormatter={(label) => formatBucketTooltip(Number(label), bucket, locale)}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar
            dataKey="success"
            fill="var(--color-success)"
            radius={4}
            animationDuration={animMs}
            animationEasing="ease-out"
            onClick={
              onSelectBucket ? (data) => onSelectBucket(Number((data as { bucket?: unknown }).bucket)) : undefined
            }
            cursor={onSelectBucket ? "pointer" : undefined}
          />
          <Bar
            dataKey="fail"
            fill="var(--color-fail)"
            radius={4}
            animationDuration={animMs}
            animationEasing="ease-out"
            onClick={
              onSelectBucket ? (data) => onSelectBucket(Number((data as { bucket?: unknown }).bucket)) : undefined
            }
            cursor={onSelectBucket ? "pointer" : undefined}
          />
          <Bar
            dataKey="other"
            fill="var(--color-other)"
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
