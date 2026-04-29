// Model spend distribution. Slice value = USD (the operationally
// useful axis); tooltip carries the formatted dollar amount + tokens.
//
// Palette: shared neutral ramp (`--sw-chart-1..6` in theme.css) — models
// aren't a status, so they stay outside the green/red/blue/amber set
// reserved for Runs and Outcomes. Cycles when slices > ramp length.

import { Cpu } from "lucide-react";
import { Cell, Pie, PieChart } from "recharts";
import { formatTokensCompact, formatUsd } from "@/lib/format";
import { humanizeModel } from "@/lib/humanize";
import { useReducedMotion } from "@/lib/useReducedMotion";
import type { ModelDistributionRow } from "@/types/analytics";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "../ui/chart.tsx";
import { ChartCard } from "./ChartCard.tsx";

// Length of the `--sw-chart-1..N` ramp declared in theme.css. Update
// both together if more stops are added.
const CHART_RAMP_LEN = 4;

export interface ModelDonutProps {
  rows: readonly ModelDistributionRow[];
  loading?: boolean;
  onSelectModel?: (model: string, label: string) => void;
}

export function ModelDonut({ rows, loading, onSelectModel }: ModelDonutProps): JSX.Element {
  const reduceMotion = useReducedMotion();
  const animMs = reduceMotion ? 0 : 250;
  const total = rows.reduce((s, r) => s + r.costUsd, 0);
  // Model ids contain `/`, `.`, etc. which aren't valid CSS identifier
  // chars — chart.tsx emits `--color-<key>` so the key needs to be
  // sanitized. Map model → indexed cssKey, keep the raw model for
  // tooltips / click handlers.
  const entries = rows.map((r, i) => ({
    row: r,
    cssKey: `m${i}`,
    color: `var(--sw-chart-${(i % CHART_RAMP_LEN) + 1})`,
  }));
  const config: ChartConfig = {};
  for (const e of entries) {
    config[e.cssKey] = { label: humanizeModel(e.row.model), color: e.color };
  }
  return (
    <ChartCard
      title="Models"
      icon={<Cpu className="size-4" />}
      height={260}
      loading={loading}
      empty={total === 0 && !loading}
    >
      <ChartContainer config={config} className="mx-auto aspect-square max-h-full">
        <PieChart>
          <ChartTooltip
            content={
              <ChartTooltipContent
                hideLabel
                valueFormatter={(value, _name, payload) => {
                  const row = payload as ModelDistributionRow | undefined;
                  const tokens = row ? ` · ${formatTokensCompact(row.tokens)} tok` : "";
                  return `${formatUsd(Number(value))}${tokens}`;
                }}
              />
            }
          />
          <Pie
            data={entries.map((e) => ({ ...e.row, name: e.cssKey, cssKey: e.cssKey }))}
            dataKey="costUsd"
            nameKey="name"
            animationDuration={animMs}
            animationEasing="ease-out"
            onClick={
              onSelectModel
                ? (slice) => {
                    const row = slice as { model?: unknown };
                    const model = typeof row.model === "string" ? row.model : "";
                    if (model) onSelectModel(model, humanizeModel(model));
                  }
                : undefined
            }
            cursor={onSelectModel ? "pointer" : undefined}
          >
            {entries.map((e) => (
              <Cell key={e.cssKey} fill={`var(--color-${e.cssKey})`} />
            ))}
          </Pie>
          <ChartLegend
            content={<ChartLegendContent nameKey="name" />}
            className="-translate-y-1 flex-wrap gap-2 *:basis-1/4 *:justify-center"
          />
        </PieChart>
      </ChartContainer>
    </ChartCard>
  );
}
