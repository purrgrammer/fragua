// Bucketed runs over time, stacked one layer per category. Eight raw
// statuses collapse into four (success / failure / paused / queued)
// via `statusCategory`, so the legend stays at four pills. Only
// success and failure carry status colors; paused and queued use two
// distinct neutral grays so the chart reads as success-vs-failure
// with secondary "still moving" states de-emphasised.
//
// Click any bar segment → drawer scoped to that bucket's runs in that
// category.

import { Play } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Rectangle, XAxis, YAxis } from "recharts";
import {
  categoryAccentVar,
  categoryLabel,
  formatBucketTick,
  formatBucketTooltip,
  RUN_CATEGORIES,
  type RunCategory,
  statusCategory,
} from "@/lib/humanize";
import { useLocale } from "@/lib/locale";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { type BucketKind, RUN_STATUS_KEYS, type RunStatusKey, type RunsBucketRow } from "@/types/analytics";
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

export interface RunsChartProps {
  rows: readonly RunsBucketRow[];
  bucket: BucketKind;
  loading?: boolean;
  /** Drill into one (bucket × category) slice. */
  onSelectSlice?: (bucketMs: number, category: RunCategory) => void;
  /** Headline total + comparison baseline rendered in the card header. */
  total: { current: number | undefined; previous: number | null };
}

interface CategoryRow {
  bucket: number;
  success: number;
  queued: number;
  paused: number;
  failure: number;
}

const config: ChartConfig = Object.fromEntries(
  RUN_CATEGORIES.map((c) => [c, { label: categoryLabel(c), color: `var(${categoryAccentVar(c)})` }]),
);

// recharts' Legend defaults to `itemSorter: "value"` (alphabetical by
// label), which scrambles RUN_CATEGORIES order. Sort by category rank
// instead so the legend mirrors the canonical order. Pie/bar both
// expose the category in `dataKey` (Bar) or `value` (Pie via slice
// name) — try both.
const legendItemSorter = (item: { value?: unknown; dataKey?: unknown }): number => {
  const k = String(item.dataKey ?? item.value ?? "");
  const idx = (RUN_CATEGORIES as readonly string[]).indexOf(k);
  return idx === -1 ? RUN_CATEGORIES.length : idx;
};

const totalFormat: Intl.NumberFormatOptions = { notation: "compact", maximumFractionDigits: 1 };

function rankOf(key: string): number {
  const idx = (RUN_CATEGORIES as readonly string[]).indexOf(key);
  return idx === -1 ? RUN_CATEGORIES.length : idx;
}

function collapseRow(r: RunsBucketRow): CategoryRow {
  const out: CategoryRow = { bucket: r.bucket, success: 0, failure: 0, paused: 0, queued: 0 };
  for (const k of RUN_STATUS_KEYS) out[statusCategory(k)] += r[k satisfies RunStatusKey];
  return out;
}

export function RunsChart({ rows, bucket, loading, onSelectSlice, total }: RunsChartProps): JSX.Element {
  const locale = useLocale();
  const reduceMotion = useReducedMotion();
  const animMs = reduceMotion ? 0 : 250;
  const collapsed = rows.map(collapseRow);
  const rowsTotal = collapsed.reduce((s, r) => s + r.success + r.queued + r.paused + r.failure, 0);

  return (
    <ChartCard
      title="Runs"
      icon={<Play className="size-4" />}
      headerRight={<ChartTotal current={total.current} previous={total.previous} format={totalFormat} />}
      loading={loading}
      empty={rowsTotal === 0 && !loading}
    >
      <ChartContainer config={config} className="size-full">
        <BarChart data={collapsed} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
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
            // recharts defaults to itemSorter:"name" (alphabetical),
            // which scrambles the stack ordering in the tooltip. Pin
            // it to the canonical RUN_CATEGORIES order instead.
            itemSorter={(item) => rankOf(String(item.dataKey ?? ""))}
            content={
              <ChartTooltipContent
                indicator="dot"
                labelFormatter={(label) => formatBucketTooltip(Number(label), bucket, locale)}
              />
            }
          />
          <ChartLegend
            itemSorter={legendItemSorter}
            content={<ChartLegendContent />}
            className="-translate-y-1 justify-center gap-3"
          />
          {RUN_CATEGORIES.map((category) => (
            <Bar
              key={category}
              dataKey={category}
              stackId="runs"
              fill={`var(--color-${category})`}
              shape={(barProps: unknown) => {
                const p = barProps as { payload: CategoryRow };
                return (
                  <Rectangle
                    {...(barProps as React.ComponentProps<typeof Rectangle>)}
                    radius={visibleSegmentRadius<RunCategory>(p.payload, RUN_CATEGORIES, category)}
                  />
                );
              }}
              animationDuration={animMs}
              animationEasing="ease-out"
              onClick={
                onSelectSlice
                  ? (data) => onSelectSlice(Number((data as { bucket?: unknown }).bucket), category)
                  : undefined
              }
              cursor={onSelectSlice ? "pointer" : undefined}
            />
          ))}
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}
