// Sub-runs section on the run-detail page (P5 of
// `docs/proposals/parallel.md`). Renders the parent's children — one
// row per sub-run with status badge, cost, branch index, and a link to
// its own run-detail page. Hidden when the run has no children (top-
// level runs of workflows without `parallel`).

import { useQuery } from "@tanstack/react-query";
import type { RunSummary } from "../lib/api.ts";
import { queries } from "../lib/queries.ts";
import { BranchActions } from "./BranchActions.tsx";
import { RunStatusBadge } from "./RunStatusBadge.tsx";

interface SubRunListProps {
  /** Parent run id. The current run-detail page's id; sub-runs are
   *  fetched as `parent_run_id = parentRunId` children. */
  parentRunId: string;
}

function formatCost(usd: number | undefined): string {
  if (usd == null || usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** The badge accepts coarse `status` only; running_children (raw status)
 *  collapses to "running" for the pill. */
function mapStatus(child: RunSummary): RunSummary["status"] {
  return child.status;
}

export function SubRunList({ parentRunId }: SubRunListProps): JSX.Element | null {
  const { data: children, isLoading } = useQuery(queries.runs.children(parentRunId));

  if (isLoading) return null;
  if (children == null || children.length === 0) return null;

  return (
    <section className="rounded-md border bg-sw-bg" data-testid="sub-runs-section">
      <header className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-sw-muted">Sub-runs ({children.length})</h2>
        <span className="text-xs text-sw-muted">
          {children.filter((c) => c.runStatus === "completed").length}/{children.length} completed
        </span>
      </header>
      <ul className="divide-y" data-testid="sub-runs-list">
        {children.map((child) => (
          <li key={child.runId} className="flex items-center gap-3 px-3 py-2" data-testid="sub-run-row">
            <span className="font-mono text-xs text-sw-muted shrink-0 w-6 text-right">
              #{child.parallelIndex ?? "?"}
            </span>
            <RunStatusBadge status={mapStatus(child)} runStatus={child.runStatus} />
            {/* Sub-runs are an executor implementation detail — operators
                shouldn't navigate into them. The row stays on the
                parent's detail page; BranchActions exposes the per-child
                operator controls (Resume / Cancel / Manage →) inline so
                the operator can act without leaving the parent's surface. */}
            <span className="flex-1 truncate font-mono text-xs text-sw-muted" data-testid="sub-run-branch-label">
              {child.branchNodeId ?? child.parentNodeId ?? "branch"}
            </span>
            <span className="text-xs tabular-nums text-sw-muted shrink-0">{formatCost(child.costUsd)}</span>
            <BranchActions runId={child.runId} runStatus={child.runStatus} parentRunId={parentRunId} />
          </li>
        ))}
      </ul>
    </section>
  );
}
