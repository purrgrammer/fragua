// Workflows by run count, rendered as a stack of horizontal bars with
// the workflow name inset left and the run count flagged right. Axes
// are hidden — the labels do the work, which avoids the wasted chrome
// of an x-axis tick scale and a truncating y-axis label column.
//
// Rows arriving from the server are keyed per workflow_sha; the same
// workflow file may appear under several shas (recompiles, edits). We
// fold them into one bar per humanised name so the chart doesn't show
// the same workflow stacked against itself. The drilldown still needs
// a single sha — pick the busiest one as a representative.
//
// Click a bar → drawer scoped to that workflow's runs in the window.

import { Workflow } from "lucide-react";
import { Bar, BarChart, LabelList, XAxis, YAxis } from "recharts";
import { humanizeWorkflow } from "@/lib/humanize";
import { useReducedMotion } from "@/lib/useReducedMotion";
import type { TopWorkflowRow } from "@/types/analytics";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart.tsx";
import { ChartCard } from "./ChartCard.tsx";
import { NEUTRAL_SOLO } from "./chart-palette.ts";

export interface TopWorkflowsBarProps {
  rows: readonly TopWorkflowRow[];
  loading?: boolean;
  onSelectWorkflow?: (workflowSha: string, workflowName: string) => void;
}

const config: ChartConfig = {
  runs: { label: "Runs", color: NEUTRAL_SOLO },
};

interface BarRow extends TopWorkflowRow {
  label: string;
}

export function TopWorkflowsBar({ rows, loading, onSelectWorkflow }: TopWorkflowsBarProps): JSX.Element {
  const reduceMotion = useReducedMotion();
  const animMs = reduceMotion ? 0 : 250;
  const data: BarRow[] = dedupeByLabel(rows);
  const total = data.reduce((s, r) => s + r.runs, 0);
  // ~28px per row keeps the card compact while leaving room for the
  // 22px bars to breathe. Minimum kept just above the empty-state
  // height so the card doesn't collapse to a sliver.
  const height = Math.max(140, data.length * 28 + 16);

  return (
    <ChartCard
      title="Workflows"
      icon={<Workflow className="size-4" />}
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
            <LabelList dataKey="label" position="insideLeft" offset={8} fill="var(--sw-text)" fontSize={12} />
            <LabelList dataKey="runs" position="right" offset={8} fill="var(--sw-muted)" fontSize={12} />
          </Bar>
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

// Fold rows that humanise to the same label into a single bar, summing
// runs/success/fail/costUsd and keeping the sha with the most runs as
// the click-target representative. Order preserved by the input row's
// first appearance, then re-sorted by total runs desc so the busiest
// workflow ends up on top regardless of which sha came first.
function dedupeByLabel(rows: readonly TopWorkflowRow[]): BarRow[] {
  const byLabel = new Map<string, BarRow>();
  for (const r of rows) {
    const label = humanizeWorkflow(r.workflowName, r.workflowSha);
    const existing = byLabel.get(label);
    if (!existing) {
      byLabel.set(label, { ...r, label });
      continue;
    }
    const merged: BarRow = {
      ...existing,
      runs: existing.runs + r.runs,
      success: existing.success + r.success,
      fail: existing.fail + r.fail,
      costUsd: existing.costUsd + r.costUsd,
    };
    if (r.runs > existing.runs) {
      merged.workflowSha = r.workflowSha;
      merged.workflowName = r.workflowName;
    }
    byLabel.set(label, merged);
  }
  return Array.from(byLabel.values()).sort((a, b) => b.runs - a.runs);
}
