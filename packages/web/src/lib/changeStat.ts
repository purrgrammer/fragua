import type { RunSummary, SnapshotChangeStat } from "./api.ts";

/**
 * Pick the display stat for a worktree-inbox row.
 * Prefers `committed` when non-null, falls back to `uncommitted`.
 * Returns `null` when both sides are absent or null.
 */
export function summarizeChangeStat(cs: RunSummary["changeStat"]): SnapshotChangeStat | null {
  if (!cs) return null;
  return cs.committed ?? cs.uncommitted;
}
