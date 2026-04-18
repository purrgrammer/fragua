// /jobs — the daemon's job queue viewed through the web UI.
//
// Surfaces queued + running + recent terminal jobs. The 2s poll lives
// on `queries.jobs.list`. Cancel buttons are shown for queued + running
// rows; on click they fire `cancelJob` via `useMutation` and invalidate
// the jobs cache so the table reflects the new state.
//
// When the API returns 503 (the server is running without a daemon) we
// render an informative empty state — the top-level DaemonBanner
// already tells the user what's wrong; this just keeps the content area
// from rendering a confusing "no jobs" when the truth is "no daemon to
// have jobs".

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Zap } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import { ApiError, cancelJob, type JobStatus } from "../lib/api.ts";
import { queries } from "../lib/queries.ts";

export function Jobs(): JSX.Element {
  const qc = useQueryClient();
  const { data: rows, isPending, error } = useQuery(queries.jobs.list({ limit: 100 }));
  const noDaemon = error instanceof ApiError && error.status === 503;
  const otherError = error && !noDaemon;

  const cancel = useMutation({
    mutationFn: (jobId: string) => cancelJob(jobId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queries.jobs.all() });
      void qc.invalidateQueries({ queryKey: queries.pipelines.all() });
    },
    onError: (err, jobId) => {
      console.warn(`[Jobs] cancel ${jobId} failed —`, err instanceof Error ? err.message : String(err));
    },
  });

  return (
    <section className="flex w-full min-w-0 flex-col gap-3">
      <h2 className="font-heading text-base font-semibold">Jobs</h2>
      {isPending && (
        <p className="text-muted-foreground text-sm" data-testid="jobs-loading">
          Loading…
        </p>
      )}
      {otherError && (
        <EmptyState
          data-testid="jobs-error"
          title="Couldn't load jobs"
          description="The server didn't respond as expected. Check the console for details, or retry shortly."
        />
      )}
      {noDaemon && (
        <EmptyState
          data-testid="jobs-no-daemon"
          icon={<Zap className="size-6" />}
          title="Daemon not running"
          description={
            <span>
              Start the daemon with <code className="font-mono">swarm daemon start</code> to enqueue and run jobs from
              the UI.
            </span>
          }
        />
      )}
      {rows && rows.length === 0 && (
        <EmptyState
          data-testid="jobs-empty"
          icon={<Zap className="size-6" />}
          title="No jobs yet"
          description={
            <span>
              Enqueue one with <code className="font-mono">curl -X POST /api/jobs -d '&#123;"workflow":"…"&#125;'</code>{" "}
              or wait for the CLI client (phase 7).
            </span>
          }
        />
      )}
      {rows && rows.length > 0 && (
        <div className="w-full min-w-0 overflow-x-auto">
          <Table data-testid="jobs-table" className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-52">Run</TableHead>
                <TableHead>Workflow</TableHead>
                <TableHead className="w-32">Status</TableHead>
                <TableHead className="w-40">Enqueued</TableHead>
                <TableHead className="w-28 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} data-testid={`job-row-${row.id}`}>
                  <TableCell className="max-w-0 truncate font-medium">
                    <Link
                      to={`/pipelines/${encodeURIComponent(row.runId)}`}
                      className="hover:underline"
                      title={row.runId}
                    >
                      {shortId(row.runId)}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-0">
                    <code className="block truncate font-mono text-xs text-muted-foreground" title={row.workflow}>
                      {row.workflow}
                    </code>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={row.status} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatAge(row.enqueuedAt)}</TableCell>
                  <TableCell className="text-right">
                    {(row.status === "queued" || row.status === "running") && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => cancel.mutate(row.id)}
                        disabled={cancel.isPending}
                        data-testid={`job-cancel-${row.id}`}
                      >
                        Cancel
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function shortId(runId: string): string {
  return runId.length > 18 ? `${runId.slice(0, 16)}…` : runId;
}

function StatusBadge({ status }: { status: JobStatus }): JSX.Element {
  const variant: Record<JobStatus, "default" | "secondary" | "destructive" | "outline"> = {
    queued: "outline",
    running: "default",
    success: "secondary",
    failed: "destructive",
    canceled: "secondary",
  };
  return (
    <Badge variant={variant[status]} data-testid={`job-status-${status}`}>
      {status}
    </Badge>
  );
}

/** Relative age like "5s ago" / "3m ago" / "2h ago". */
function formatAge(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const deltaSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}
