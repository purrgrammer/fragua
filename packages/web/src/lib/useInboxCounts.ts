// useInboxCounts — combined count of both inbox sections.
//
// Reads the two existing query cache slots (blocked runs + worktree-pending)
// so there is no extra fetch: the same queryOptions instances that
// Inbox.tsx and WorktreeInbox.tsx use are reused here, meaning TanStack
// Query deduplicates them across all consumers.

import { useQuery } from "@tanstack/react-query";
import { ATTENTION_STATUSES } from "../components/Inbox.tsx";
import { queries } from "./queries.ts";

const BLOCKED_FILTER = { status: ATTENTION_STATUSES, order: "oldest" as const };
const WORKTREE_FILTER = { inbox: "pending" as const, order: "oldest" as const };

export interface InboxCounts {
  /** Runs in paused_human / paused / quarantined. */
  blocked: number;
  /** Terminal runs with inbox_status='pending'. */
  worktree: number;
  /** Sum of blocked + worktree. */
  total: number;
  /** True while either query is still loading for the first time. */
  isPending: boolean;
}

export function useInboxCounts(): InboxCounts {
  const { data: blockedData, isPending: blockedPending } = useQuery(queries.runs.list(BLOCKED_FILTER));
  const { data: worktreeData, isPending: worktreePending } = useQuery(queries.runs.list(WORKTREE_FILTER));

  const blocked = blockedData?.length ?? 0;
  const worktree = worktreeData?.length ?? 0;

  return {
    blocked,
    worktree,
    total: blocked + worktree,
    isPending: blockedPending || worktreePending,
  };
}
