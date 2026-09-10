import type { DetailOverlay } from "./useDetailOverlay.ts";

type OverlaySlice = Pick<DetailOverlay, "nodeStates" | "status">;

/** Terminal run statuses — reaching one means the final (terminal)
 * snapshot is now available, so the Diff tab's view is stale. */
const TERMINATED = new Set<DetailOverlay["status"]>(["success", "fail", "canceled"]);

/** True when an SSE frame moved the run in a way that changes the worktree
 * diff: a workflow step reached a finished state (`completed`/`failed`) or the
 * run itself terminated. Drives invalidation of the run's snapshots +
 * snapshot-diff queries so the Diff tab refetches while a running run streams.
 * Pure — compares the previous overlay slice against the next. */
export function diffNeedsRefetch(prev: OverlaySlice, next: OverlaySlice): boolean {
  if (next.status !== null && next.status !== prev.status && TERMINATED.has(next.status)) {
    return true;
  }
  for (const [key, entry] of next.nodeStates) {
    if (entry.state !== "completed" && entry.state !== "failed") continue;
    const before = prev.nodeStates.get(key);
    if (before === undefined || before.state !== entry.state) return true;
  }
  return false;
}
