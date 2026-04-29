// Outcome distribution as a solid pie. Eight raw statuses collapse
// into four categories (success / failure / paused / queued) so the
// donut and the Runs chart speak the same vocabulary.
//
// Layout follows the shadcn pie pattern: square aspect ratio with the
// legend rendered inside the same container, wrapped to 4-wide rows
// so it lines up with the Runs chart legend.

import { Flag } from "lucide-react";
import { Cell, Pie, PieChart } from "recharts";
import { categoryAccentVar, categoryLabel, RUN_CATEGORIES, type RunCategory, statusCategory } from "@/lib/humanize";
import { useReducedMotion } from "@/lib/useReducedMotion";
import type { HaltDistributionRow } from "@/types/analytics";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "../ui/chart.tsx";
import { ChartCard } from "./ChartCard.tsx";

export interface HaltDonutProps {
  rows: readonly HaltDistributionRow[];
  loading?: boolean;
  /** Drill into one outcome category (success / queued / paused / failure). */
  onSelectCategory?: (category: RunCategory, label: string) => void;
}

const config: ChartConfig = Object.fromEntries(
  RUN_CATEGORIES.map((c) => [c, { label: categoryLabel(c), color: `var(${categoryAccentVar(c)})` }]),
);

// recharts' Legend defaults to alphabetical sort by label. Force the
// canonical RUN_CATEGORIES order. Pie legend items expose the slice
// name as `value`; bar legend items expose the category as `dataKey`.
const legendItemSorter = (item: { value?: unknown; dataKey?: unknown }): number => {
  const k = String(item.dataKey ?? item.value ?? "");
  const idx = (RUN_CATEGORIES as readonly string[]).indexOf(k);
  return idx === -1 ? RUN_CATEGORIES.length : idx;
};

interface CategoryRow {
  category: RunCategory;
  count: number;
}

function rollUp(rows: readonly HaltDistributionRow[]): CategoryRow[] {
  const totals: Record<RunCategory, number> = { success: 0, failure: 0, paused: 0, queued: 0 };
  for (const r of rows) totals[statusCategory(r.status)] += r.count;
  return RUN_CATEGORIES.filter((c) => totals[c] > 0).map((c) => ({ category: c, count: totals[c] }));
}

export function HaltDonut({ rows, loading, onSelectCategory }: HaltDonutProps): JSX.Element {
  const reduceMotion = useReducedMotion();
  const animMs = reduceMotion ? 0 : 250;
  const total = rows.reduce((s, r) => s + r.count, 0);
  const slices = rollUp(rows);

  return (
    <ChartCard
      title="Outcomes"
      icon={<Flag className="size-4" />}
      height={260}
      loading={loading}
      empty={total === 0 && !loading}
    >
      <ChartContainer config={config} className="mx-auto aspect-square max-h-full">
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent hideLabel valueFormatter={(value) => String(value)} />} />
          <Pie
            data={slices.map((s) => ({ ...s, name: s.category }))}
            dataKey="count"
            nameKey="name"
            animationDuration={animMs}
            animationEasing="ease-out"
            onClick={
              onSelectCategory
                ? (slice) => {
                    const name = String((slice as { name?: unknown }).name ?? "") as RunCategory;
                    if (RUN_CATEGORIES.includes(name)) onSelectCategory(name, categoryLabel(name));
                  }
                : undefined
            }
            cursor={onSelectCategory ? "pointer" : undefined}
          >
            {slices.map((s) => (
              <Cell key={s.category} fill={`var(--color-${s.category})`} />
            ))}
          </Pie>
          <ChartLegend
            itemSorter={legendItemSorter}
            content={<ChartLegendContent />}
            className="-translate-y-1 justify-center gap-3"
          />
        </PieChart>
      </ChartContainer>
    </ChartCard>
  );
}
