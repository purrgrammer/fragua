// Halt-reason distribution as a solid pie. Slices carry the colour of
// each underlying state accent so a "Success" slice reads as green and
// "Failure" as red, matching the rest of the app.
//
// Layout follows the shadcn pie pattern: square aspect ratio with the
// legend rendered inside the same container, wrapped into 4-wide rows
// so longer status lists don't stretch the card.

import { Cell, Pie, PieChart } from "recharts";
import { haltReasonAccentVar, humanizeHaltReason } from "@/lib/humanize";
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
  onSelectStatus?: (status: string, label: string) => void;
}

export function HaltDonut({ rows, loading, onSelectStatus }: HaltDonutProps): JSX.Element {
  const reduceMotion = useReducedMotion();
  const animMs = reduceMotion ? 0 : 250;
  const total = rows.reduce((s, r) => s + r.count, 0);
  const config: ChartConfig = {};
  for (const r of rows) {
    config[r.status] = { label: humanizeHaltReason(r.status), color: `var(${haltReasonAccentVar(r.status)})` };
  }

  return (
    <ChartCard title="Outcomes" caption="halt reasons" height={260} loading={loading} empty={total === 0 && !loading}>
      <ChartContainer config={config} className="mx-auto aspect-square max-h-full">
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent hideLabel valueFormatter={(value) => String(value)} />} />
          <Pie
            data={rows.map((r) => ({ ...r, name: r.status }))}
            dataKey="count"
            nameKey="name"
            animationDuration={animMs}
            animationEasing="ease-out"
            onClick={
              onSelectStatus
                ? (slice) => {
                    const status = String((slice as { name?: unknown }).name ?? "");
                    if (status) onSelectStatus(status, humanizeHaltReason(status));
                  }
                : undefined
            }
            cursor={onSelectStatus ? "pointer" : undefined}
          >
            {rows.map((r) => (
              <Cell key={r.status} fill={`var(--color-${r.status})`} />
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
