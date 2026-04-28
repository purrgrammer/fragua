// Bucketed token usage, stacked input vs output. Cache reads/writes
// have their own chart — splitting them out keeps both readable.

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { formatTokensCompact, formatTokensLong } from "@/lib/format";
import { formatBucketTick, formatBucketTooltip } from "@/lib/humanize";
import { useLocale } from "@/lib/locale";
import { useReducedMotion } from "@/lib/useReducedMotion";
import type { BucketKind, TokensBucketRow } from "@/types/analytics";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "../ui/chart.tsx";
import { ChartCard } from "./ChartCard.tsx";

export interface TokensChartProps {
  rows: readonly TokensBucketRow[];
  bucket: BucketKind;
  loading?: boolean;
  onSelectBucket?: (bucketMs: number) => void;
}

const config: ChartConfig = {
  inputTokens: { label: "Input", color: "var(--sw-accent-thinking)" },
  outputTokens: { label: "Output", color: "var(--sw-accent-loop)" },
};

export function TokensChart({ rows, bucket, loading, onSelectBucket }: TokensChartProps): JSX.Element {
  const locale = useLocale();
  const reduceMotion = useReducedMotion();
  const animMs = reduceMotion ? 0 : 250;
  const total = rows.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);

  return (
    <ChartCard title="Tokens" caption="input vs output" loading={loading} empty={total === 0 && !loading}>
      <ChartContainer config={config} className="size-full">
        <BarChart data={rows as TokensBucketRow[]} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
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
            dataKey="inputTokens"
            fill="var(--color-inputTokens)"
            radius={4}
            animationDuration={animMs}
            animationEasing="ease-out"
            onClick={
              onSelectBucket ? (data) => onSelectBucket(Number((data as { bucket?: unknown }).bucket)) : undefined
            }
            cursor={onSelectBucket ? "pointer" : undefined}
          />
          <Bar
            dataKey="outputTokens"
            fill="var(--color-outputTokens)"
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
