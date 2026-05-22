// /schedules — read-only viewer for the `schedules` table with control
// verbs (pause / resume / delete). The CLI keeps owning create.
//
// Polling-only: the schedule routes don't publish over SSE. The 10s
// `refetchInterval` on `queries.schedules.list()` is the single source
// of freshness.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { useEffect } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/ui/alert-dialog.tsx";
import { Button } from "../components/ui/button.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import { WorkflowLink } from "../components/WorkflowLink.tsx";
import type { ScheduleRunRow, ScheduleWithStripe } from "../lib/api.ts";
import * as api from "../lib/api.ts";
import { queries } from "../lib/queries.ts";
import { toast, toastError } from "../lib/toast.ts";

const STRIPE_LEN = 10;

export function Schedules(): JSX.Element {
  const { data: rows, isPending, isError, error } = useQuery(queries.schedules.list());

  useEffect(() => {
    if (error)
      console.warn("[Schedules] failed to load schedules —", error instanceof Error ? error.message : String(error));
  }, [error]);

  return (
    <section className="flex w-full min-w-0 flex-col gap-3">
      <h2 className="font-heading text-base font-semibold">Schedules</h2>
      {isPending && (
        <p className="text-sw-muted text-sm" data-testid="schedules-loading">
          Loading…
        </p>
      )}
      {isError && (
        <EmptyState
          data-testid="schedules-error"
          title="Couldn't load schedules"
          description="The server didn't respond as expected. Check the console for details, or retry shortly."
        />
      )}
      {rows && rows.length === 0 && (
        <EmptyState
          data-testid="schedules-empty"
          icon={<CalendarClock className="size-6" />}
          title="No schedules configured"
          description={
            <span>
              Create one from the CLI: <code className="font-mono">fragua schedule create</code>.
            </span>
          }
        />
      )}
      {rows && rows.length > 0 && (
        <div className="w-full min-w-0 overflow-x-auto">
          <Table data-testid="schedules-table" className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-44">Workflow</TableHead>
                <TableHead className="w-32">Project</TableHead>
                <TableHead className="w-20">Interval</TableHead>
                <TableHead className="w-20">Status</TableHead>
                <TableHead className="w-32">Health</TableHead>
                <TableHead className="w-44 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <ScheduleRow key={row.id} row={row} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function ScheduleRow({ row }: { row: ScheduleWithStripe }): JSX.Element {
  const qc = useQueryClient();
  const invalidate = (): Promise<unknown> => qc.invalidateQueries({ queryKey: queries.schedules.all() });

  const pauseM = useMutation({
    mutationFn: () => api.pauseSchedule(row.id),
    onSuccess: () => {
      toast.success("Schedule paused");
      return invalidate();
    },
    onError: (err) => toastError(err),
  });
  const resumeM = useMutation({
    mutationFn: () => api.resumeSchedule(row.id),
    onSuccess: () => {
      toast.success("Schedule resumed");
      return invalidate();
    },
    onError: (err) => toastError(err),
  });
  const deleteM = useMutation({
    mutationFn: () => api.deleteSchedule(row.id),
    onSuccess: () => {
      toast.success("Schedule deleted");
      return invalidate();
    },
    onError: (err) => toastError(err),
  });

  const isPaused = row.pausedAt != null;
  const status: "active" | "paused" = isPaused ? "paused" : "active";

  return (
    <TableRow data-testid={`schedule-row-${row.id}`}>
      <TableCell className="max-w-0 truncate font-medium" title={row.workflowRef}>
        <WorkflowLink
          name={row.workflowRef}
          cwd={row.cwd}
          variant="plain"
          className="transition-colors duration-[var(--sw-duration-hover)] hover:underline"
        />
      </TableCell>
      <TableCell className="max-w-0 truncate" title={row.cwd}>
        <code className="font-mono text-xs text-sw-muted" data-testid={`schedule-cwd-${row.id}`}>
          {basename(row.cwd)}
        </code>
      </TableCell>
      <TableCell>
        <code className="font-mono text-xs">{row.intervalText}</code>
      </TableCell>
      <TableCell>
        <StatusPill status={status} />
      </TableCell>
      <TableCell>
        <HealthStripe runs={row.recentRuns} />
      </TableCell>
      <TableCell className="text-right">
        <div className="inline-flex items-center gap-1">
          {isPaused ? (
            <Button
              size="sm"
              variant="outline"
              data-testid={`schedule-resume-${row.id}`}
              disabled={resumeM.isPending}
              onClick={() => resumeM.mutate()}
            >
              Resume
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              data-testid={`schedule-pause-${row.id}`}
              disabled={pauseM.isPending}
              onClick={() => pauseM.mutate()}
            >
              Pause
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                variant="destructive"
                data-testid={`schedule-delete-${row.id}`}
                disabled={deleteM.isPending}
              >
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent data-testid={`schedule-delete-dialog-${row.id}`}>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete schedule?</AlertDialogTitle>
                <AlertDialogDescription>
                  Stops <span className="font-medium text-[var(--sw-text)]">{row.workflowRef}</span> from firing every{" "}
                  <code className="font-mono">{row.intervalText}</code> in{" "}
                  <code className="font-mono">{basename(row.cwd)}</code>. Runs already spawned by this schedule are
                  unaffected. This can't be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel asChild>
                  <Button variant="outline" data-testid={`schedule-delete-cancel-${row.id}`}>
                    Cancel
                  </Button>
                </AlertDialogCancel>
                <AlertDialogAction asChild>
                  <Button
                    variant="destructive"
                    data-testid={`schedule-delete-confirm-${row.id}`}
                    onClick={() => deleteM.mutate()}
                  >
                    Delete schedule
                  </Button>
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </TableCell>
    </TableRow>
  );
}

function StatusPill({ status }: { status: "active" | "paused" }): JSX.Element {
  const tone =
    status === "active"
      ? "bg-sw-accent-success/10 text-sw-accent-success border-sw-accent-success/30"
      : "bg-sw-accent-idle/10 text-sw-accent-idle border-sw-accent-idle/30";
  return (
    <span
      data-testid={`schedule-status-${status}`}
      data-status={status}
      className={`inline-block shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tone}`}
    >
      {status}
    </span>
  );
}

function HealthStripe({ runs }: { runs: ScheduleRunRow[] }): JSX.Element {
  // Render up to STRIPE_LEN cells, oldest → newest. The wire payload
  // is newest-first, so we reverse before slicing. Empty trailing
  // slots render as neutral ghost cells so width is stable across rows.
  const ordered = [...runs].reverse().slice(-STRIPE_LEN);
  const ghostCount = Math.max(0, STRIPE_LEN - ordered.length);
  return (
    <div data-testid="schedule-health-stripe" className="inline-flex items-center gap-px">
      {Array.from({ length: ghostCount }).map((_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: ghost cells are positional placeholders
          key={`ghost-${i}`}
          aria-hidden="true"
          data-tone="ghost"
          className="inline-block h-3 w-1.5 rounded-[1px] bg-sw-border"
        />
      ))}
      {ordered.map((r) => {
        const tone = healthTone(r.status);
        const cls =
          tone === "success" ? "bg-sw-accent-success" : tone === "error" ? "bg-sw-accent-error" : "bg-sw-accent-idle";
        return (
          <span
            key={r.runId}
            title={`${r.runId} · ${r.status}`}
            data-tone={tone}
            className={`inline-block h-3 w-1.5 rounded-[1px] ${cls}`}
          />
        );
      })}
    </div>
  );
}

function healthTone(status: string): "success" | "error" | "neutral" {
  if (status === "completed") return "success";
  if (status === "halted" || status === "cancelled") return "error";
  return "neutral";
}

function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}
