// /inbox — unified operator inbox with two clearly-labelled sections:
//
//   1. "Needs input"   — blocked runs (paused_human / paused / quarantined)
//                        that require a decision before they can continue.
//   2. "Ready to land" — terminal runs with inbox_status='pending' whose
//                        git work needs a Branch / Commit / Merge / Discard
//                        decision.
//
// When both sections are empty a single combined empty state is shown.
// Home renders capped previews of both with "View all → /inbox".

import { ShieldCheck } from "lucide-react";
import { Inbox } from "../components/Inbox.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { WorktreeInbox } from "../components/WorktreeInbox.tsx";
import { useInboxCounts } from "../lib/useInboxCounts.ts";

export function InboxPage(): JSX.Element {
  const { blocked, worktree, isPending } = useInboxCounts();
  const bothEmpty = !isPending && blocked === 0 && worktree === 0;

  if (bothEmpty) {
    return (
      <section className="flex w-full min-w-0 flex-col gap-6">
        <EmptyState
          data-testid="inbox-empty-combined"
          icon={<ShieldCheck className="size-6 text-sw-accent-success" aria-hidden />}
          title="All clear"
          description="No runs need attention right now."
          className="min-h-[160px]"
        />
      </section>
    );
  }

  return (
    <section className="flex w-full min-w-0 flex-col gap-6">
      <Inbox title="Needs input" testId="inbox-needs-input" />
      <WorktreeInbox title="Ready to land" />
    </section>
  );
}
