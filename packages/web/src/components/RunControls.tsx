// RunControls — operator-driven Pause / Resume / Cancel for a run.
//
// Specialized banners own the action for their substatus:
//   - paused_provider_error → RunPausedNotice (Resume + Cancel)
//   - paused_hitl           → HitlChoice (option buttons)
// RunControls handles the "everything else" surface: generic operator
// pause, resume of an operator-paused run, and cancel-from-anywhere on
// non-terminal runs. Returns null when no action applies (terminal
// runs, or when a specialized banner already owns every action).
//
// Cancel is terminal and irreversible — gated behind a single inline
// two-step (first click flips into a 3s confirm window; second click
// fires). No AlertDialog primitive lives under components/ui yet.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cancelRun, pauseRun, type RunDetail, resumeRun } from "../lib/api.ts";
import { queries } from "../lib/queries.ts";
import { Button } from "./ui/button.tsx";

export interface RunControlsProps {
  runId: string;
  status: RunDetail["status"];
  runStatus: RunDetail["runStatus"];
}

const CONFIRM_WINDOW_MS = 3_000;

async function refreshAfterControl(qc: ReturnType<typeof useQueryClient>, runId: string): Promise<void> {
  await qc.invalidateQueries(queries.runs.detail(runId));
  await qc.invalidateQueries({ queryKey: ["run-paused-events", runId] });
}

export function RunControls({ runId, status, runStatus }: RunControlsProps): JSX.Element | null {
  const qc = useQueryClient();

  const pauseM = useMutation({
    mutationFn: () => pauseRun(runId),
    onSuccess: () => refreshAfterControl(qc, runId),
  });
  const resumeM = useMutation({
    mutationFn: () => resumeRun(runId),
    onSuccess: () => refreshAfterControl(qc, runId),
  });
  const cancelM = useMutation({
    mutationFn: (reason?: string) => cancelRun(runId, reason),
    onSuccess: () => refreshAfterControl(qc, runId),
  });

  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [reason, setReason] = useState("");
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current != null) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const armConfirm = (): void => {
    setConfirmingCancel(true);
    if (confirmTimerRef.current != null) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => {
      setConfirmingCancel(false);
      setReason("");
    }, CONFIRM_WINDOW_MS);
  };

  const fireCancel = (): void => {
    if (confirmTimerRef.current != null) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setConfirmingCancel(false);
    const trimmed = reason.trim();
    cancelM.mutate(trimmed.length > 0 ? trimmed : undefined);
    setReason("");
  };

  const canPause = status === "running";
  // Resume is the *generic operator-pause* path only. Specialized
  // substatuses route Resume through their own banner so we don't
  // double up the action surface.
  const canResume = status === "paused" && runStatus !== "paused_hitl" && runStatus !== "paused_provider_error";
  // Cancel is available everywhere non-terminal. RunPausedNotice
  // already exposes a Cancel for paused_provider_error — hide ours
  // there to avoid two adjacent Cancel buttons.
  const canCancel =
    (status === "running" || status === "queued" || status === "paused") && runStatus !== "paused_provider_error";

  if (!canPause && !canResume && !canCancel) return null;

  const busy = pauseM.isPending || resumeM.isPending || cancelM.isPending;
  const errorMessage =
    cancelM.error instanceof Error
      ? cancelM.error.message
      : resumeM.error instanceof Error
        ? resumeM.error.message
        : pauseM.error instanceof Error
          ? pauseM.error.message
          : null;

  return (
    <div
      className="flex flex-col gap-2 rounded-sw-card border border-sw-border bg-sw-surface px-3 py-2 text-sw-text"
      data-testid="run-controls"
    >
      <div className="flex flex-wrap items-center gap-2">
        {canPause && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => pauseM.mutate()}
            data-testid="run-controls-pause"
          >
            <Pause />
            Pause
          </Button>
        )}
        {canResume && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => resumeM.mutate()}
            data-testid="run-controls-resume"
          >
            <Play />
            Resume
          </Button>
        )}
        {canCancel &&
          (confirmingCancel ? (
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={fireCancel}
              data-testid="run-controls-cancel-confirm"
            >
              <X />
              Confirm cancel
            </Button>
          ) : (
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={armConfirm}
              data-testid="run-controls-cancel"
            >
              <X />
              Cancel
            </Button>
          ))}
      </div>

      {confirmingCancel && (
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Optional reason"
          rows={2}
          disabled={busy}
          data-testid="run-controls-cancel-reason"
          className="w-full resize-none rounded-sw-card border border-sw-border bg-sw-bg px-2 py-1 text-sw-xs text-sw-text placeholder:text-sw-muted focus:outline-none"
        />
      )}

      {errorMessage && (
        <p className="text-sw-xs text-sw-danger" data-testid="run-controls-error">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
