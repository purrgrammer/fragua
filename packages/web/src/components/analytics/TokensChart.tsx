// Bucketed token usage, stacked input vs output. Cache reads/writes
// have their own chart — splitting them out keeps both readable.

import { Coins } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Rectangle, XAxis, YAxis } from "recharts";
import { formatTokensCompact, formatTokensLong, tokensCompactFormatOptions } from "@/lib/format";
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
import { visibleSegmentRadius } from "./chart-stack.ts";
import { ChartTotal } from "./ChartTotal.tsx";

const TOKEN_KEYS = ["inputTokens", "outputTokens"] as const;
type TokenKey = (typeof TOKEN_KEYS)[number];

export interface TokensChartProps {
  rows: readonly TokensBucketRow[];
  bucket: BucketKind;
  loading?: boolean;
  onSelectBucket?: (bucketMs: number) => void;
  /** Headline total (fresh input + output) + comparison baseline. */
  total: { current: number | undefined; previous: number | null };
}

const config: ChartConfig = {
  inputTokens: { label: "Input", color: "var(--sw-chart-pair-primary)" },
  outputTokens: { label: "Output", color: "var(--sw-chart-pair-secondary)" },
};

export function TokensChart({ rows, bucket, loading, onSelectBucket, total }: TokensChartProps): JSX.Element {
  const locale = useLocale();
  const reduceMotion = useReducedMotion();
  const animMs = reduceMotion ? 0 : 250;
  const rowsTotal = rows.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);

  return (
    <ChartCard
      title="Tokens"
      icon={<Coins className="size-4" />}
      headerRight={
        <ChartTotal
          current={total.current}
          previous={total.previous}
          format={tokensCompactFormatOptions(total.current ?? 0)}
        />
      }
      loading={loading}
      empty={rowsTotal === 0 && !loading}
    >
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
                indicator="dot"
                labelFormatter={(label) => formatBucketTooltip(Number(label), bucket, locale)}
                valueFormatter={(value) => formatTokensLong(Number(value))}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          {TOKEN_KEYS.map((key) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="tokens"
              fill={`var(--color-${key})`}
              shape={(barProps: unknown) => {
                const p = barProps as { payload: TokensBucketRow };
                return (
                  <Rectangle
                    {...(barProps as React.ComponentProps<typeof Rectangle>)}
                    radius={visibleSegmentRadius<TokenKey>(p.payload, TOKEN_KEYS, key)}
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
