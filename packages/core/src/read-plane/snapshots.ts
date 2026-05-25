// Snapshot scrubber projection + diff-range resolution.
//
// `toScrubberRow` folds one snapshot event (snapshot.captured observability or
// fact.snapshot_recorded terminal) into a wire-stable `SnapshotItem`. The
// diff-range resolution (`against=base|previous|<eventIdx>`) is a PURE function
// over the projected list + the run's base shas — it picks the two commit shas
// a `git diff` runs between, with no git or I/O of its own, so the HTTP server
// and the CLI store-client resolve identically.

import type { StoredEvent } from "@fragua/store";
import type { SnapshotCapturedData } from "@fragua/types";

export interface SnapshotStat {
  files: number;
  additions: number;
  deletions: number;
}

/** Wire shape of one item in the scrubber list. */
export interface SnapshotItem {
  eventIdx: number;
  nodeId: string | null;
  /** Human-readable label for this boundary.
   *  "terminal" = fact.snapshot_recorded
   *  "hitl"     = snapshot.captured with nodeId null (HITL pause)
   *  "step"     = snapshot.captured with a nodeId (per-step) */
  label: "terminal" | "hitl" | "step";
  commitSha: string;
  treeSha: string;
  committed: SnapshotStat | null;
  uncommitted: SnapshotStat | null;
}

export function toScrubberRow(ev: StoredEvent): SnapshotItem {
  const p = ev.payload as Partial<SnapshotCapturedData> & {
    committed?: { files: number; additions: number; deletions: number } | null;
    uncommitted?: { files: number; additions: number; deletions: number } | null;
  };

  const nodeId = p.nodeId ?? null;
  const label: SnapshotItem["label"] =
    ev.type === "fact.snapshot_recorded" ? "terminal" : nodeId === null ? "hitl" : "step";

  return {
    eventIdx: ev.seq,
    nodeId,
    label,
    commitSha: (p.commitSha as string) ?? "",
    treeSha: (p.treeSha as string) ?? "",
    committed: (p.committed as SnapshotStat | null | undefined) ?? null,
    uncommitted: (p.uncommitted as SnapshotStat | null | undefined) ?? null,
  };
}

export function extractCommitSha(ev: StoredEvent): string | null {
  const p = ev.payload as Record<string, unknown>;
  const sha = p["commitSha"];
  return typeof sha === "string" && sha.length > 0 ? sha : null;
}

/** Parse a non-negative integer eventIdx, or `null` on a malformed token. */
export function parseEventIdx(s: string): number | null {
  if (s.length === 0) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/** Resolution of a snapshot diff request into the two commit shas a `git diff`
 *  runs between, plus the run's worktree `cwd`. `against` selects the from-side:
 *  "base" / "previous" / a literal eventIdx; the to-side is always the target
 *  snapshot's commit. Refusals mirror the HTTP route's error taxonomy 1:1. */
export type DiffRange =
  | { ok: true; cwd: string; fromSha: string; toSha: string }
  | {
      ok: false;
      reason: "run_not_found" | "no_worktree" | "snapshot_not_found" | "invalid_against" | "base_missing";
    };
