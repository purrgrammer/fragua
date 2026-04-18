// Compact row component for pipeline summaries. Two variants share the
// same three-element shape: title (link), workflow (neutral badge), and
// status (right-aligned pill). Any per-run detail — started-at, cost,
// tokens, events, duration — lives on the pipeline detail page, not the
// list row. This keeps the list easy to scan at a glance.
//
// Variants:
//   - `"default"` — table-row layout used by `PipelinesList` inside a
//     `<table>`. Renders a `<tr>` so the surrounding `<thead>` /
//     `<tbody>` semantics survive. Status lives in its own right-most
//     `<td>`.
//   - `"compact"` — single-line link card used in Home's recent-runs
//     list. Renders an `<a>` so the whole row is one click target;
//     status is pinned right via `ml-auto`.
//
// Truncation: both variants clamp the title with `truncate` inside a
// `min-w-0` parent. Without `min-w-0` flex/grid children refuse to
// shrink below their intrinsic content width and long titles blow
// out the row, which is how we used to get horizontal scroll on
// the Pipelines list.

import { Link } from "react-router-dom";
import type { PipelineSummary } from "../lib/api.ts";
import { statusLabel } from "../lib/format.ts";
import { Badge } from "./ui/badge.tsx";

/** Number of leading runId chars shown in hover tooltips or callers
 *  that still want a short form. No longer used in-row, but kept as
 *  an export because Home's `RunningCard` imports it. */
const RUN_ID_SHORT_LEN = 8;

export interface PipelineRowProps {
  row: PipelineSummary;
  variant?: "default" | "compact";
}

export function PipelineRow({ row, variant = "default" }: PipelineRowProps): JSX.Element {
  if (variant === "compact") return <CompactRow row={row} />;
  return <TableRow row={row} />;
}

/** Default variant — one `<tr>` with three `<td>`s:
 *  Title link · Workflow badge · Status pill (right-aligned). */
function TableRow({ row }: { row: PipelineSummary }): JSX.Element {
  const wf = row.workflowName ?? row.workflow;
  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50">
      <td className="py-2 pr-4 max-w-0">
        <Link
          to={`/pipelines/${row.runId}`}
          title={displayTooltip(row)}
          className="block truncate font-medium text-blue-700 hover:underline"
        >
          {displayTitle(row)}
        </Link>
      </td>
      <td className="py-2 pr-4 max-w-0">
        {wf ? (
          <Badge variant="muted" className="max-w-full truncate">
            {wf}
          </Badge>
        ) : null}
      </td>
      <td className="py-2 pr-4 text-right">
        <StatusPill status={row.status} />
      </td>
    </tr>
  );
}

/** Compact variant — whole row is one `<a>`, so keyboards / screen
 *  readers see exactly one focusable element per row. Status pinned
 *  to the right with `ml-auto`. */
function CompactRow({ row }: { row: PipelineSummary }): JSX.Element {
  const wf = row.workflowName ?? row.workflow;
  return (
    <Link
      to={`/pipelines/${row.runId}`}
      title={displayTooltip(row)}
      data-testid={`recent-run-${row.runId}`}
      className="flex w-full min-w-0 items-center gap-3 rounded-md border border-border/60 bg-card px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
    >
      <span className="flex-1 min-w-0 truncate font-medium">{displayTitle(row)}</span>
      {wf ? (
        <Badge variant="muted" className="max-w-[12rem] shrink-0 truncate">
          {wf}
        </Badge>
      ) : null}
      <StatusPill status={row.status} />
    </Link>
  );
}

/** Truncate a runId to its leading `RUN_ID_SHORT_LEN` chars, no ellipsis.
 *  Re-exported for Home's `RunningCard`, which still shows a short runId
 *  on its in-progress cards. */
export function shortenRunId(runId: string): string {
  return runId.length > RUN_ID_SHORT_LEN ? runId.slice(0, RUN_ID_SHORT_LEN) : runId;
}

/** Display priority for the row's primary label:
 *   1. `title` — auto-generated summariser title (Wave 2b)
 *   2. `input` — raw $ARGUMENTS, clamped (so pre-Wave-2b runs still read
 *      as something useful once the backfill script fills titles)
 *   3. `workflowName` / `workflow` — legacy pipelines list fallback
 *   4. runId — last-resort so we never render an empty link */
export function displayTitle(row: PipelineSummary): string {
  if (row.title && row.title.length > 0) return row.title;
  if (row.input && row.input.length > 0) return clampInline(row.input, 80);
  return row.workflowName ?? row.workflow ?? row.runId;
}

/** Tooltip with the untruncated input + workflow + runId — so hovering
 *  reveals everything the row hid (including the full runId, which is
 *  no longer shown as a cell). */
export function displayTooltip(row: PipelineSummary): string {
  const parts: string[] = [];
  if (row.title) parts.push(`title: ${row.title}`);
  if (row.input) parts.push(`input: ${row.input}`);
  const wf = row.workflowName ?? row.workflow;
  if (wf) parts.push(`workflow: ${wf}`);
  parts.push(`runId: ${row.runId}`);
  return parts.join("\n");
}

function clampInline(s: string, cap: number): string {
  const singleLine = s.replace(/\s+/g, " ").trim();
  return singleLine.length > cap ? `${singleLine.slice(0, cap - 1)}…` : singleLine;
}

export function StatusPill({ status }: { status: PipelineSummary["status"] }): JSX.Element {
  const tone =
    status === "success"
      ? "bg-emerald-100 text-emerald-800 border-emerald-300"
      : status === "fail"
        ? "bg-rose-100 text-rose-800 border-rose-300"
        : status === "running"
          ? "bg-blue-100 text-blue-800 border-blue-300"
          : "bg-slate-100 text-slate-700 border-slate-300";
  return (
    <span
      data-testid={`status-${status}`}
      className={`inline-block shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tone}`}
    >
      {statusLabel(status)}
    </span>
  );
}
