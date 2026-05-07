// Compact row component for run summaries. Two variants share the
// same three-element shape: title (link), workflow (neutral badge), and
// status (right-aligned pill). Any per-run detail — started-at, cost,
// tokens, events, duration — lives on the run detail page, not the
// list row. This keeps the list easy to scan at a glance.
//
// Variants:
//   - `"default"` — table-row layout used by `RunsList` inside a
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
// the Runs list.

import { Link } from "react-router-dom";
import type { RunSummary } from "../lib/api.ts";
import { shortRunId } from "../lib/runId.ts";
import { RunStatusBadge } from "./RunStatusBadge.tsx";
import { Badge } from "./ui/badge.tsx";
import { WorkflowLink } from "./WorkflowLink.tsx";

// Run-id formatting moved to `lib/runId.ts` (`shortRunId`) so it
// produces `prefix…suffix` and disambiguates runs queued in the same
// second. Kept `shortenRunId` here as a re-export for back-compat.

export interface RunRowProps {
  row: RunSummary;
  variant?: "default" | "compact";
}

export function RunRow({ row, variant = "default" }: RunRowProps): JSX.Element {
  if (variant === "compact") return <CompactRow row={row} />;
  return <TableRow row={row} />;
}

/** Default variant — one `<tr>` with three `<td>`s:
 *  Title link · Workflow badge · Status pill (right-aligned). */
function TableRow({ row }: { row: RunSummary }): JSX.Element {
  const wf = row.workflowName ?? row.workflow;
  // Hover on hot rows: omit bg animation on rows users traverse hundreds
  // of times per session. Title link keeps underline-on-hover for affordance.
  return (
    <tr className="border-b border-sw-border">
      <td className="py-2 pr-4 max-w-0">
        <Link
          to={`/runs/${row.runId}`}
          title={displayTooltip(row)}
          className="block truncate font-medium text-sw-text hover:underline"
        >
          {displayTitle(row)}
        </Link>
      </td>
      <td className="py-2 pr-4 max-w-0">{wf ? <WorkflowLink name={wf} variant="badge" /> : null}</td>
      <td className="py-2 pr-4 text-right">
        <RunStatusBadge status={row.status} runStatus={row.runStatus} />
      </td>
    </tr>
  );
}

/** Compact variant — whole row is one `<a>`, so keyboards / screen
 *  readers see exactly one focusable element per row. Status pinned
 *  to the right with `ml-auto`. */
function CompactRow({ row }: { row: RunSummary }): JSX.Element {
  const wf = row.workflowName ?? row.workflow;
  return (
    <Link
      to={`/runs/${row.runId}`}
      title={displayTooltip(row)}
      data-testid={`recent-run-${row.runId}`}
      className="flex w-full min-w-0 items-center gap-3 rounded-sw-card border border-sw-border bg-sw-surface px-3 py-2 text-sw-sm hover:[&_.run-title]:underline"
    >
      <span className="run-title flex-1 min-w-0 truncate font-medium text-sw-text">{displayTitle(row)}</span>
      {wf ? (
        <Badge variant="muted" className="max-w-[12rem] shrink-0 truncate">
          {wf}
        </Badge>
      ) : null}
      <RunStatusBadge status={row.status} />
    </Link>
  );
}

/** Compact runId for in-progress cards. Delegates to the shared helper
 *  so all surfaces produce the same `prefix…suffix` shape. */
export function shortenRunId(runId: string): string {
  return shortRunId(runId);
}

/** Display priority for the row's primary label:
 *   1. `title` — auto-generated summariser title
 *   2. `input` — raw $ARGUMENTS, clamped
 *   3. `workflowName` / `workflow` — fallback
 *   4. runId — last resort so we never render an empty link */
export function displayTitle(row: RunSummary): string {
  if (row.title && row.title.length > 0) return row.title;
  if (row.input && row.input.length > 0) return clampInline(row.input, 80);
  return row.workflowName ?? row.workflow ?? row.runId;
}

/** Tooltip with the untruncated input + workflow + runId — so hovering
 *  reveals everything the row hid (including the full runId, which is
 *  no longer shown as a cell). */
export function displayTooltip(row: RunSummary): string {
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

/** @deprecated Import `RunStatusBadge` from `./RunStatusBadge.tsx` directly.
 *  This alias exists only for backwards-compat with any external callers. */
export { RunStatusBadge as StatusPill } from "./RunStatusBadge.tsx";
