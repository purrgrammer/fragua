import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { queries } from "../lib/queries.ts";
import { SnapshotDiffView } from "./SnapshotDiffView.tsx";
import { SnapshotScrubber } from "./SnapshotScrubber.tsx";
import { EmptyState } from "./ui/empty-state.tsx";

export interface RunDiffTabProps {
  runId: string;
}

export function RunDiffTab({ runId }: RunDiffTabProps): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();

  const snapshotsQuery = useQuery(queries.runs.snapshots(runId));
  const snapshots = snapshotsQuery.data ?? [];

  /** Derive selected snapshot from URL, defaulting to the latest. */
  const snapParam = searchParams.get("snap");
  const selectedEventIdx = (() => {
    if (snapshots.length === 0) return -1;
    const last = snapshots[snapshots.length - 1];
    if (!last) return -1;
    if (snapParam !== null) {
      const parsed = parseInt(snapParam, 10);
      if (!Number.isNaN(parsed) && snapshots.some((s) => s.eventIdx === parsed)) {
        return parsed;
      }
    }
    return last.eventIdx;
  })();

  const against = searchParams.get("against") ?? "base";

  const handleSelectSnapshot = useCallback(
    (eventIdx: number) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("snap", String(eventIdx));
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const handleChangeAgainst = useCallback(
    (value: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("against", value);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  if (snapshotsQuery.isPending) {
    return (
      <div className="p-3 text-sw-sm text-sw-muted" data-testid="run-diff-loading">
        Loading snapshots…
      </div>
    );
  }

  if (snapshots.length === 0) {
    return (
      <EmptyState
        data-testid="run-diff-empty"
        title="No snapshots"
        description="This run has no worktree snapshots. Bare-cwd runs or runs without a worktree do not capture diff history."
        density="compact"
      />
    );
  }

  return (
    <section
      className="grid h-full min-h-0 grid-cols-[16rem_1fr] divide-x divide-sw-border"
      data-testid="run-diff-section"
    >
      <SnapshotScrubber snapshots={snapshots} selectedEventIdx={selectedEventIdx} onSelect={handleSelectSnapshot} />
      {selectedEventIdx >= 0 && (
        <div className="flex min-h-0 min-w-0 flex-col gap-3 p-3">
          <SnapshotDiffView
            runId={runId}
            eventIdx={selectedEventIdx}
            against={against}
            snapshots={snapshots}
            onChangeAgainst={handleChangeAgainst}
          />
        </div>
      )}
    </section>
  );
}
