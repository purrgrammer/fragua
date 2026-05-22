// WorktreeInboxRow — one row in the "Ready to land" inbox section.
//
// Matches the InboxRow visual style (single row, border-l-2 accent,
// no status badge) with an additional change-stat badge and RunActions
// dropdown for accept/discard.

import { Link } from "react-router-dom";
import type { RunSummary } from "../lib/api.ts";
import { summarizeChangeStat } from "../lib/changeStat.ts";
import { ChangeStat } from "./ChangeStat.tsx";
import { RunActions } from "./RunActions.tsx";
import { displayTitle, displayTooltip } from "./RunRow.tsx";
import { Badge } from "./ui/badge.tsx";

export function WorktreeInboxRow({ row }: { row: RunSummary }): JSX.Element {
  const stat = summarizeChangeStat(row.changeStat);

  return (
    <li
      data-testid={`worktree-inbox-row-${row.runId}`}
      className="flex w-full min-w-0 items-center gap-3 rounded-sw-card border border-sw-border border-l-2 bg-sw-surface px-3 py-2 text-sw-sm"
      style={{ borderLeftColor: "var(--sw-accent-success)" }}
    >
      <Link
        to={`/runs/${row.runId}`}
        title={displayTooltip(row)}
        className="min-w-0 flex-1 truncate font-medium text-sw-text hover:underline"
      >
        {displayTitle(row)}
      </Link>

      {stat && (
        <Badge variant="muted" className="shrink-0" data-testid={`worktree-inbox-stat-${row.runId}`}>
          <ChangeStat stat={stat} />
        </Badge>
      )}

      <RunActions row={row} />
    </li>
  );
}
