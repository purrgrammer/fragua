// Bucketed token usage, stacked across the four buckets (input / cache
// write / cache read / output). The Cache chart still exists but
// answers a different question (read vs write share); this one is the
// "where did the tokens go" surface — billed total in the header,
// per-bucket stacks in the bars.

import { Coins } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
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
import { ChartTotal } from "./ChartTotal.tsx";
import { renderStackSegment } from "./chart-stack.tsx";
import { ANALYTICS_COLORS } from "./palette.ts";

// Stack order = bar order from bottom to top, mirroring the popover's
// row order: Input · Cache write · Cache read · Output. Pairs with the
// dark→light palette so the bar reads as a clean lightness ramp.
const TOKEN_KEYS = ["inputTokens", "cacheWriteTokens", "cacheReadTokens", "outputTokens"] as const;
type TokenKey = (typeof TOKEN_KEYS)[number];

export interface TokensChartProps {
  rows: readonly TokensBucketRow[];
  bucket: BucketKind;
  loading?: boolean;
  onSelectBucket?: (bucketMs: number) => void;
  /** Headline billed total (input + output + cache_read + cache_write)
   * + comparison baseline rendered in the card header. */
  total: { current: number | undefined; previous: number | null };
}

const config: ChartConfig = {
  inputTokens: { label: "Input", color: ANALYTICS_COLORS.input },
  cacheWriteTokens: { label: "Cache write", color: ANALYTICS_COLORS.cacheWrite },
  cacheReadTokens: { label: "Cache read", color: ANALYTICS_COLORS.cacheRead },
  outputTokens: { label: "Output", color: ANALYTICS_COLORS.output },
};

function rankOf(key: string): number {
  const idx = (TOKEN_KEYS as readonly string[]).indexOf(key);
  return idx === -1 ? TOKEN_KEYS.length : idx;
}

export function TokensChart({ rows, bucket, loading, onSelectBucket, total }: TokensChartProps): JSX.Element {
  const locale = useLocale();
  const reduceMotion = useReducedMotion();
  const animMs = reduceMotion ? 0 : 250;
  const rowsTotal = rows.reduce(
    (s, r) => s + r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens,
    0,
  );

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
          {TOKEN_KEYS.map((key) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="tokens"
              fill={`var(--color-${key})`}
              shape={(barProps: unknown) => renderStackSegment<TokenKey>(barProps, TOKEN_KEYS, key)}
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
