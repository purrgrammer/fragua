import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, type RunDetail, type RunSnapshot } from "../lib/api.ts";
import { queries } from "../lib/queries.ts";
import { CodeBlock } from "./ai-elements/code-block.tsx";
import { ChangeStat } from "./ChangeStat.tsx";
import { RunActions } from "./RunActions.tsx";
import { EmptyState } from "./ui/empty-state.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";

export interface RunDiffTabProps {
  runId: string;
  /** Pass the already-loaded RunDetail so RunActions can offer inbox actions
   * without a second fetch. When absent (e.g. loaded stand-alone) the
   * actions panel is simply hidden. */
  run?: RunDetail;
}

/** Selector label for a snapshot: the step (node) name. The terminal /
 *  HITL boundaries carry no node, so they fall back to a one-word kind. */
export function snapshotLabel(snap: RunSnapshot): string {
  if (snap.nodeId) return snap.nodeId;
  return snap.label === "hitl" ? "HITL" : "terminal";
}

export function RunDiffTab({ runId, run }: RunDiffTabProps): JSX.Element {
  const snapshotsQuery = useQuery(queries.runs.snapshots(runId));
  const snapshots = snapshotsQuery.data ?? [];

  /** `null` = "latest" sentinel; otherwise the `eventIdx` of the chosen snapshot. */
  const [selectedEventIdx, setSelectedEventIdx] = useState<number | null>(null);

  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  const selected =
    selectedEventIdx === null ? latest : (snapshots.find((s) => s.eventIdx === selectedEventIdx) ?? latest);

  const diffQuery = useQuery({
    ...queries.runs.snapshotDiff(runId, selected?.eventIdx ?? -1, "base"),
    enabled: selected !== null && selected !== undefined,
  });

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

  const stat = selected ? (selected.committed ?? selected.uncommitted) : null;

  return (
    <section className="flex min-h-0 flex-col gap-3 p-3" data-testid="run-diff-section">
      <div className="flex min-w-0 items-center gap-3">
        <SnapshotSelector
          snapshots={snapshots}
          selectedEventIdx={selectedEventIdx}
          latestEventIdx={latest?.eventIdx ?? null}
          onChange={setSelectedEventIdx}
        />
        {stat && (
          <ChangeStat
            className="flex-1 text-sw-sm"
            stat={stat}
            data-testid="run-diff-stat"
            insertionsTestId="run-diff-insertions"
            deletionsTestId="run-diff-deletions"
          />
        )}
        {run && <RunActions row={run} />}
      </div>

      <div
        className="min-w-0 flex-1 overflow-auto rounded-sw-card border border-sw-border bg-sw-surface"
        data-testid="snapshot-diff-content"
      >
        {diffQuery.isPending ? (
          <div className="p-3 text-sw-sm text-sw-muted">Loading diff…</div>
        ) : diffQuery.isError ? (
          <DiffError error={diffQuery.error} />
        ) : diffQuery.data === "" ? (
          <EmptyState data-testid="snapshot-diff-empty" title="No changes vs base" density="compact" />
        ) : diffQuery.data !== undefined ? (
          <CodeBlock code={diffQuery.data} language="diff" wrap />
        ) : null}
      </div>
    </section>
  );
}

interface SnapshotSelectorProps {
  snapshots: RunSnapshot[];
  /** `null` ⇒ following the newest snapshot. */
  selectedEventIdx: number | null;
  /** `eventIdx` of the newest snapshot — what `null` resolves to. */
  latestEventIdx: number | null;
  onChange: (eventIdx: number | null) => void;
}

function SnapshotSelector({
  snapshots,
  selectedEventIdx,
  latestEventIdx,
  onChange,
}: SnapshotSelectorProps): JSX.Element {
  // `null` (follow-latest) resolves to the newest snapshot — there's no
  // separate "Latest" row, since for a terminal run it would duplicate the
  // terminal snapshot. Picking the newest row re-enters follow-latest.
  const value = String(selectedEventIdx ?? latestEventIdx ?? -1);

  function handleChange(v: string): void {
    const idx = Number(v);
    onChange(idx === latestEventIdx ? null : idx);
  }

  return (
    <Select value={value} onValueChange={handleChange}>
      <SelectTrigger size="sm" className="max-w-56 font-mono" data-testid="snapshot-selector">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {snapshots.map((snap) => (
          <SelectItem
            key={snap.eventIdx}
            value={String(snap.eventIdx)}
            data-testid={`snapshot-option-${snap.eventIdx}`}
          >
            {snapshotLabel(snap)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function DiffError({ error }: { error: unknown }): JSX.Element {
  const status = error instanceof ApiError ? error.status : 0;
  let msg: string;
  if (status === 410) msg = "Worktree or base ref disposed; diff unavailable.";
  else if (status === 404) msg = "Snapshot not found.";
  else msg = "Couldn't load diff.";
  return <EmptyState data-testid="snapshot-diff-error" title={msg} density="compact" />;
}
