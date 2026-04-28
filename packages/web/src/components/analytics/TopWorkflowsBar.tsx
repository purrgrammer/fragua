// Top workflows by run count, rendered as a stack of horizontal bars
// with the workflow name inset left and the run count flagged right.
// Axes are hidden — the labels do the work, which avoids the wasted
// chrome of an x-axis tick scale and a truncating y-axis label column.
//
// Click a bar → drawer scoped to that workflow's runs in the window.

import { Bar, BarChart, LabelList, XAxis, YAxis } from "recharts";
import { humanizeWorkflow } from "@/lib/humanize";
import { useReducedMotion } from "@/lib/useReducedMotion";
import type { TopWorkflowRow } from "@/types/analytics";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart.tsx";
import { ChartCard } from "./ChartCard.tsx";

export interface TopWorkflowsBarProps {
  rows: readonly TopWorkflowRow[];
  loading?: boolean;
  onSelectWorkflow?: (workflowSha: string, workflowName: string) => void;
}

const config: ChartConfig = {
  runs: { label: "Runs", color: "var(--sw-accent-thinking)" },
};

interface BarRow extends TopWorkflowRow {
  label: string;
}

export function TopWorkflowsBar({ rows, loading, onSelectWorkflow }: TopWorkflowsBarProps): JSX.Element {
  const reduceMotion = useReducedMotion();
  const animMs = reduceMotion ? 0 : 250;
  const data: BarRow[] = rows.map((r) => ({
    ...r,
    label: humanizeWorkflow(r.workflowName, r.workflowSha),
  }));
  const total = data.reduce((s, r) => s + r.runs, 0);
  // ~28px per row keeps the card compact while leaving room for the
  // 22px bars to breathe. Minimum kept just above the empty-state
  // height so the card doesn't collapse to a sliver.
  const height = Math.max(140, data.length * 28 + 16);

  return (
    <ChartCard
      title="Top workflows"
      caption="runs in window"
      height={height}
      loading={loading}
      empty={total === 0 && !loading}
    >
      <ChartContainer config={config} className="size-full">
        <BarChart accessibilityLayer data={data} layout="vertical" margin={{ right: 32 }}>
          {/* No grid — the in-bar workflow name and right-side count are
              the value carriers; a leftmost vertical grid line at x=0
              read as an unwanted Y-axis line. */}
          {/* `width={0}` collapses the reserved axis column so hidden
              doesn't leave a leading gap. layout="vertical" still
              needs the category axis to bind labels to bars. */}
          <YAxis dataKey="label" type="category" hide width={0} />
          <XAxis dataKey="runs" type="number" hide />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                indicator="line"
                valueFormatter={(value, _name, payload) => {
                  const r = payload as TopWorkflowRow | undefined;
                  if (!r) return String(value);
                  const parts: string[] = [`${value} runs`];
                  if (r.success > 0) parts.push(`${r.success}✓`);
                  if (r.fail > 0) parts.push(`${r.fail}✗`);
                  return parts.join(" · ");
                }}
              />
            }
          />
          <Bar
            dataKey="runs"
            fill="var(--color-runs)"
            radius={4}
            barSize={22}
            animationDuration={animMs}
            animationEasing="ease-out"
            onClick={
              onSelectWorkflow
                ? (data) => {
                    const r = data as unknown as BarRow;
                    onSelectWorkflow(r.workflowSha, r.label);
                  }
                : undefined
            }
            cursor={onSelectWorkflow ? "pointer" : undefined}
          >
            <LabelList dataKey="label" position="insideLeft" offset={8} fill="var(--sw-bg)" fontSize={12} />
            <LabelList dataKey="runs" position="right" offset={8} fill="var(--sw-muted)" fontSize={12} />
          </Bar>
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}
