import { useQuery } from "@tanstack/react-query";
import type { RunSnapshot } from "../lib/api.ts";
import { ApiError } from "../lib/api.ts";
import { queries } from "../lib/queries.ts";
import { CodeBlock } from "./ai-elements/code-block.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";

export interface SnapshotDiffViewProps {
  runId: string;
  eventIdx: number;
  against: string;
  snapshots: RunSnapshot[];
  onChangeAgainst: (against: string) => void;
}

export function SnapshotDiffView({
  runId,
  eventIdx,
  against,
  snapshots,
  onChangeAgainst,
}: SnapshotDiffViewProps): JSX.Element {
  const diffQuery = useQuery(queries.runs.snapshotDiff(runId, eventIdx, against));

  /** Earlier snapshots usable as arbitrary compare targets (excludes the
   * selected one). Ordered newest-first so the most recent prior is on top. */
  const earlierSnapshots = snapshots
    .filter((s) => s.eventIdx < eventIdx)
    .slice()
    .reverse();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="snapshot-diff-view">
      <div className="flex items-center gap-2">
        <span className="text-sw-sm text-sw-muted">Compare against</span>
        <Select value={against} onValueChange={onChangeAgainst}>
          <SelectTrigger className="h-7 w-auto min-w-[8rem] text-sw-sm" data-testid="snapshot-diff-against-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="base">base</SelectItem>
            <SelectItem value="previous">previous</SelectItem>
            {earlierSnapshots.map((s) => {
              const optLabel = s.nodeId ? `#${s.eventIdx} ${s.nodeId}` : `#${s.eventIdx}`;
              return (
                <SelectItem key={s.eventIdx} value={String(s.eventIdx)}>
                  {optLabel}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
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
          <div className="p-3 text-sw-sm text-sw-muted" data-testid="snapshot-diff-empty">
            No changes vs {against}.
          </div>
        ) : diffQuery.data !== undefined ? (
          <CodeBlock code={diffQuery.data} language="diff" />
        ) : null}
      </div>
    </div>
  );
}

function DiffError({ error }: { error: unknown }): JSX.Element {
  const status = error instanceof ApiError ? error.status : 0;
  let msg: string;
  if (status === 410) msg = "Worktree or base ref disposed; diff unavailable.";
  else if (status === 404) msg = "Snapshot not found.";
  else msg = "Couldn't load diff.";
  return (
    <div className="p-3 text-sw-sm text-sw-muted" data-testid="snapshot-diff-error">
      {msg}
    </div>
  );
}
