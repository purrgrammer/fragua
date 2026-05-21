// WorktreeInboxRow — one row in the "Recoverable work" inbox section.
//
// Shows: run title (link to detail), change-stat badge, terminal status
// badge, and the <RunActions> dropdown. Inline forms were replaced by
// the dialog-based RunActions component.

import { Link } from "react-router-dom";
import type { RunSummary } from "../lib/api.ts";
import { summarizeChangeStat } from "../lib/changeStat.ts";
import { RunActions } from "./RunActions.tsx";
import { displayTitle } from "./RunRow.tsx";
import { RunStatusBadge } from "./RunStatusBadge.tsx";
import { Badge } from "./ui/badge.tsx";

export function WorktreeInboxRow({ row }: { row: RunSummary }): JSX.Element {
  const stat = summarizeChangeStat(row.changeStat);

  return (
    <li
      data-testid={`worktree-inbox-row-${row.runId}`}
      className="flex w-full min-w-0 flex-col gap-2 rounded-sw-card border border-sw-border bg-sw-surface px-3 py-2"
    >
      <div className="flex w-full min-w-0 items-center gap-2">
        {/* Title — links to run detail */}
        <Link
          to={`/runs/${row.runId}`}
          className="min-w-0 flex-1 truncate text-sw-sm font-medium text-sw-text hover:underline"
          title={row.runId}
        >
          {displayTitle(row)}
        </Link>

        {/* Change-stat badge */}
        {stat && (
          <Badge
            variant="muted"
            className="shrink-0 font-mono tabular-nums"
            data-testid={`worktree-inbox-stat-${row.runId}`}
          >
            {stat.filesChanged} {stat.filesChanged === 1 ? "file" : "files"}{" "}
            <span className="text-[var(--sw-accent-success)]">+{stat.insertions}</span>{" "}
            <span className="text-[var(--sw-accent-error)]">−{stat.deletions}</span>
          </Badge>
        )}

        {/* Terminal status */}
        <RunStatusBadge status={row.status} runStatus={row.runStatus} />

        {/* Actions dropdown */}
        <RunActions row={row} />
      </div>
    </li>
  );
}
