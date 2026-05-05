// /schedules — read-only viewer for the `schedules` table with control
// verbs (pause / resume / delete). The CLI keeps owning create.
//
// Polling-only: the schedule routes don't publish over SSE, and the
// relative-time columns ("in 12 min", "1h ago") need a steady tick to
// stay honest — the 10s `refetchInterval` on `queries.schedules.list()`
// is the single source of freshness.
//
// Row click → drilldown dialog showing the last 50 runs the schedule
// fired, each linking through to its existing /runs/:id page via the
// shared <RunRow> primitive. Action cells stop event propagation so
// pause / resume / delete don't accidentally open the dialog.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { RunRow } from "../components/RunRow.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import type { RunSummary, Schedule, ScheduleRunRow, ScheduleWithStripe } from "../lib/api.ts";
import * as api from "../lib/api.ts";
import { queries } from "../lib/queries.ts";
import { formatRelative, toIsoTitle } from "../lib/time.ts";

const STRIPE_LEN = 10;
const CONFIRM_WINDOW_MS = 5_000;

export function Schedules(): JSX.Element {
  const { data: rows, isPending, isError, error } = useQuery(queries.schedules.list());
  const [drilldownId, setDrilldownId] = useState<string | null>(null);

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
              Create one from the CLI: <code className="font-mono">swarm schedule create</code>.
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
                <TableHead className="w-32">Next fire</TableHead>
                <TableHead className="w-32">Last fire</TableHead>
                <TableHead className="w-20">Status</TableHead>
                <TableHead className="w-32">Health</TableHead>
                <TableHead className="w-64 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <ScheduleRow key={row.id} row={row} onOpen={() => setDrilldownId(row.id)} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <RunsDrilldown scheduleId={drilldownId} onClose={() => setDrilldownId(null)} />
    </section>
  );
}

interface ScheduleRowProps {
  row: ScheduleWithStripe;
  onOpen: () => void;
}

function ScheduleRow({ row, onOpen }: ScheduleRowProps): JSX.Element {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const invalidate = (): Promise<unknown> => qc.invalidateQueries({ queryKey: queries.schedules.all() });

  const pauseM = useMutation({
    mutationFn: () => api.pauseSchedule(row.id),
    onSuccess: invalidate,
  });
  const resumeM = useMutation({
    mutationFn: () => api.resumeSchedule(row.id),
    onSuccess: invalidate,
  });
  const deleteM = useMutation({
    mutationFn: () => api.deleteSchedule(row.id),
    onSuccess: invalidate,
  });

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);

  const isPaused = row.pausedAt != null;
  const status: "active" | "paused" = isPaused ? "paused" : "active";

  function handleDeleteClick(): void {
    if (!confirming) {
      setConfirming(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirming(false), CONFIRM_WINDOW_MS);
      return;
    }
    if (confirmTimer.current) {
      clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
    }
    setConfirming(false);
    deleteM.mutate();
  }

  return (
    <TableRow data-testid={`schedule-row-${row.id}`}>
      <TableCell className="max-w-0 truncate font-medium" title={row.workflowRef}>
        {row.workflowRef}
      </TableCell>
      <TableCell className="max-w-0 truncate" title={row.cwd}>
        <code className="font-mono text-xs text-sw-muted">{basename(row.cwd)}</code>
      </TableCell>
      <TableCell>
        <code className="font-mono text-xs">{row.intervalText}</code>
      </TableCell>
      <TableCell title={toIsoTitle(row.nextFireAt)}>
        <span className="text-sw-muted text-xs">{isPaused ? "—" : formatRelative(row.nextFireAt)}</span>
      </TableCell>
      <TableCell title={row.lastFireAt != null ? toIsoTitle(row.lastFireAt) : ""}>
        <span className="text-sw-muted text-xs">{row.lastFireAt != null ? formatRelative(row.lastFireAt) : "—"}</span>
      </TableCell>
      <TableCell>
        <StatusPill status={status} />
      </TableCell>
      <TableCell>
        <HealthStripe runs={row.recentRuns} />
      </TableCell>
      <TableCell className="text-right">
        <div className="inline-flex items-center gap-1">
          <Button size="sm" variant="ghost" data-testid={`schedule-runs-${row.id}`} onClick={onOpen}>
            Runs
          </Button>
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
          <Button
            size="sm"
            variant={confirming ? "destructive" : "outline"}
            data-testid={`schedule-delete-${row.id}`}
            data-confirming={confirming ? "true" : "false"}
            disabled={deleteM.isPending}
            onClick={handleDeleteClick}
          >
            {confirming ? "Confirm delete" : "Delete"}
          </Button>
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

interface RunsDrilldownProps {
  scheduleId: string | null;
  onClose: () => void;
}

function RunsDrilldown({ scheduleId, onClose }: RunsDrilldownProps): JSX.Element {
  const id = scheduleId ?? "";
  const { data, isPending } = useQuery(queries.schedules.runs(id));
  return (
    <Dialog open={scheduleId != null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Schedule runs</DialogTitle>
          <DialogDescription>
            The 50 most recent runs spawned by this schedule. Click through for the run detail page.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1" data-testid="schedule-runs-list">
          {scheduleId == null ? null : isPending ? (
            <p className="text-sw-muted text-sm">Loading…</p>
          ) : !data || data.length === 0 ? (
            <p className="text-sw-muted text-sm">No runs yet.</p>
          ) : (
            data.map((r) => <RunRow key={r.runId} variant="compact" row={toRunSummary(r)} />)
          )}
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

/** Adapter: schedule run row → minimal `RunSummary` so we can reuse
 *  <RunRow variant="compact"> + <RunStatusBadge> verbatim. The row only
 *  reads identity, title fallback, status, and (for the link) `runId`. */
function toRunSummary(r: ScheduleRunRow): RunSummary {
  return {
    runId: r.runId,
    startedAt: new Date(r.enqueuedAt).toISOString(),
    status: coerceStatus(r.status),
    eventCount: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function coerceStatus(raw: string): RunSummary["status"] {
  switch (raw) {
    case "completed":
      return "success";
    case "halted":
      return "fail";
    case "cancelled":
      return "canceled";
    case "queued":
    case "running":
    case "paused":
      return raw;
    default:
      return "unknown";
  }
}

function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

// Re-export internal helpers? No — `Schedule` is the only re-export
// callers need from the route, and it already lives in lib/api.ts.
export type { Schedule };
