// WorktreeInbox — "Ready to land" section on the /inbox page.
//
// Lists terminal runs with inbox_status='pending' (committed or
// uncommitted changes awaiting an operator action). Rendered as a
// separate titled section from the paused/quarantined Inbox.

import { useQuery } from "@tanstack/react-query";
import { Inbox as InboxIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { queries } from "../lib/queries.ts";
import { EmptyState } from "./ui/empty-state.tsx";
import { SectionTitle } from "./ui/section-title.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { WorktreeInboxRow } from "./WorktreeInboxRow.tsx";

const BASE_FILTER = { inbox: "pending" as const, order: "oldest" as const };

export interface WorktreeInboxProps {
  /** Override the section heading. Defaults to "Recoverable work". */
  title?: string;
  /** Cap rows shown. Omitted = unbounded. */
  limit?: number;
  /** When set and rows overflow limit, render a "View all →" link in the header. */
  viewAllHref?: string;
}

export function WorktreeInbox({ title, limit, viewAllHref }: WorktreeInboxProps = {}): JSX.Element {
  const filter = limit !== undefined ? { ...BASE_FILTER, limit: limit + 1 } : BASE_FILTER;
  const { data, isPending } = useQuery(queries.runs.list(filter));
  const allRows = data ?? [];

  const hasOverflow = limit !== undefined && allRows.length > limit;
  const rows = hasOverflow ? allRows.slice(0, limit) : allRows;
  const showViewAll = viewAllHref !== undefined && hasOverflow;

  return (
    <section data-testid="worktree-inbox" className="flex flex-col gap-4">
      <SectionTitle
        action={
          showViewAll && viewAllHref ? (
            <Link to={viewAllHref} className="text-sw-muted hover:text-sw-text">
              View all →
            </Link>
          ) : null
        }
      >
        {title ?? "Recoverable work"}
      </SectionTitle>

      {isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          data-testid="worktree-inbox-empty"
          icon={<InboxIcon className="size-6 text-sw-muted" aria-hidden />}
          title="No recoverable work"
          description="Terminal runs with uncommitted changes will appear here."
          density="compact"
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <WorktreeInboxRow key={row.runId} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}
