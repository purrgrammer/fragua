import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../lib/api.ts";
import { queries } from "../lib/queries.ts";
import { CodeBlock } from "./ai-elements/code-block.tsx";
import { EmptyState } from "./ui/empty-state.tsx";

export interface RunDiffTabProps {
  runId: string;
}

export function RunDiffTab({ runId }: RunDiffTabProps): JSX.Element {
  const snapshotsQuery = useQuery(queries.runs.snapshots(runId));
  const snapshots = snapshotsQuery.data ?? [];
  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

  const diffQuery = useQuery({
    ...queries.runs.snapshotDiff(runId, latest?.eventIdx ?? -1, "base"),
    enabled: latest !== null,
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

  const stat = latest ? (latest.committed ?? latest.uncommitted) : null;

  return (
    <section className="flex min-h-0 flex-col gap-3 p-3" data-testid="run-diff-section">
      {stat && (
        <p className="font-mono text-sw-sm text-sw-muted" data-testid="run-diff-stat">
          {stat.filesChanged} {stat.filesChanged === 1 ? "file" : "files"} changed,{" "}
          <span className="text-sw-accent-success" data-testid="run-diff-insertions">
            +{stat.insertions}
          </span>{" "}
          /{" "}
          <span className="text-sw-accent-error" data-testid="run-diff-deletions">
            −{stat.deletions}
          </span>
        </p>
      )}

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
          <CodeBlock code={diffQuery.data} language="diff" />
        ) : null}
      </div>
    </section>
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
