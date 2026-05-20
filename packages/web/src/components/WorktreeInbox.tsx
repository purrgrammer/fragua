// WorktreeInbox — "Recoverable work" section on the /inbox page.
//
// Lists terminal runs with inbox_status='pending' (committed or
// uncommitted changes awaiting an operator action). Renders as a
// separate titled section from the existing paused/quarantined Inbox.

import { useQuery } from "@tanstack/react-query";
import { Inbox as InboxIcon } from "lucide-react";
import { queries } from "../lib/queries.ts";
import { EmptyState } from "./ui/empty-state.tsx";
import { SectionTitle } from "./ui/section-title.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { WorktreeInboxRow } from "./WorktreeInboxRow.tsx";

const INBOX_FILTER = { inbox: "pending" as const, order: "oldest" as const };

export function WorktreeInbox(): JSX.Element {
  const { data, isPending } = useQuery(queries.runs.list(INBOX_FILTER));
  const rows = data ?? [];

  return (
    <section data-testid="worktree-inbox" className="flex flex-col gap-4">
      <SectionTitle>Recoverable work</SectionTitle>

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
