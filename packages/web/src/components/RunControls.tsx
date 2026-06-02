// RunControls — operator-driven Pause / Resume / Cancel for a run.
//
// Specialized banners own the action for their substatus:
//   - paused                → RunPausedNotice (Resume + Cancel; budget reason has Raise & Resume)
//   - paused_human           → HitlChoice (option buttons)
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
import { toast, toastError } from "../lib/toast.ts";
import { Button } from "./ui/button.tsx";

export interface RunControlsProps {
  runId: string;
  status: RunDetail["status"];
  runStatus: RunDetail["runStatus"];
  /** When the run is `paused_human` with non-empty options, HitlChoice
   * owns the action surface (operator picks one of the option buttons).
   * When options are empty, the pause was operator-driven (`POST /pause`)
   * and Resume becomes the right affordance. RunDetail passes the count;
   * 0 / undefined → operator-pause; > 0 → workflow HITL. */
  hitlOptionsCount?: number;
  /** Compact mode: drops the card wrapper, shrinks the buttons to icon-only
   * with a tooltip-style title, sized to match the status badge so the
   * controls can sit inline alongside the badge in a header row. The
   * confirm-cancel textarea + error messages still render below. */
  compact?: boolean;
  /** When true the run was brought in via `fragua import` and has no local
   * cwd. The daemon will never dispatch it, so operate controls are
   * replaced with a read-only "imported (inert)" badge. */
  imported?: boolean;
}

const CONFIRM_WINDOW_MS = 3_000;

async function refreshAfterControl(qc: ReturnType<typeof useQueryClient>, runId: string): Promise<void> {
  await qc.invalidateQueries(queries.runs.detail(runId));
  await qc.invalidateQueries({ queryKey: ["run-paused-events", runId] });
}

export function RunControls({
  runId,
  status,
  runStatus,
  hitlOptionsCount,
  compact = false,
  imported = false,
}: RunControlsProps): JSX.Element | null {
  const qc = useQueryClient();

  const pauseM = useMutation({
    mutationFn: () => pauseRun(runId),
    onSuccess: () => {
      toast.success("Run paused");
      return refreshAfterControl(qc, runId);
    },
    onError: (err) => toastError(err),
  });
  const resumeM = useMutation({
    mutationFn: () => resumeRun(runId),
    onSuccess: () => {
      toast.success("Run resumed");
      return refreshAfterControl(qc, runId);
    },
    onError: (err) => toastError(err),
  });
  const cancelM = useMutation({
    mutationFn: (reason?: string) => cancelRun(runId, reason),
    onSuccess: () => {
      toast.success("Run cancelled");
      return refreshAfterControl(qc, runId);
    },
    onError: (err) => toastError(err),
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

  if (imported) {
    return (
      <div
        className="inline-flex items-center rounded-sw-card border border-sw-border px-1.5 py-0.5 text-sw-xs text-sw-muted"
        data-testid="run-controls-imported"
      >
        imported (inert)
      </div>
    );
  }

  const canPause = status === "running";
  // Resume is the generic operator-pause path. The specialized
  // substatuses handle their own surface:
  //   - paused                  → RunPausedNotice (Resume + Cancel)
  //   - paused_human with options → HitlChoice (option buttons)
  // paused_human with NO options is the workflow-authored human-node
  // resume case (operator pauses route to `paused` now).
  // paused_auto auto-resumes on a timer; manual Resume short-circuits
  // the wait — handled in RunPausedNotice for those reasons.
  const isOperatorHitlPause = runStatus === "paused_human" && (hitlOptionsCount ?? 0) === 0;
  const canResume =
    status === "paused" && runStatus !== "paused" && (runStatus !== "paused_human" || isOperatorHitlPause);
  // Cancel is available everywhere non-terminal. RunPausedNotice
  // already exposes a Cancel for `paused` — hide ours there to avoid
  // two adjacent Cancel buttons.
  const canCancel = (status === "running" || status === "queued" || status === "paused") && runStatus !== "paused";

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

  // Compact: icon-only buttons sized to the status-badge row
  // (`text-[0.65rem] px-1.5 py-0.5` per RunDetail). Drop the card
  // wrapper so the buttons sit inline alongside the badge.
  const buttonSize = compact ? "xs" : "sm";
  const compactBtn = "h-5 px-1.5 text-[0.65rem] gap-1 [&_svg]:size-3";
  const compactClass = compact ? compactBtn : "";
  const wrapperClass = compact
    ? "flex flex-col gap-1 text-sw-text"
    : "flex flex-col gap-2 rounded-sw-card border border-sw-border bg-sw-surface px-3 py-2 text-sw-text";

  return (
    <div className={wrapperClass} data-testid="run-controls">
      <div className="flex flex-wrap items-center gap-1">
        {canPause && (
          <Button
            variant="outline"
            size={buttonSize}
            disabled={busy}
            onClick={() => pauseM.mutate()}
            data-testid="run-controls-pause"
            title="Pause"
            className={compactClass}
          >
            <Pause />
            {!compact && "Pause"}
          </Button>
        )}
        {canResume && (
          <Button
            variant="outline"
            size={buttonSize}
            disabled={busy}
            onClick={() => resumeM.mutate()}
            data-testid="run-controls-resume"
            title="Resume"
            className={compactClass}
          >
            <Play />
            {!compact && "Resume"}
          </Button>
        )}
        {canCancel &&
          (confirmingCancel ? (
            <Button
              variant="destructive"
              size={buttonSize}
              disabled={busy}
              onClick={fireCancel}
              data-testid="run-controls-cancel-confirm"
              title="Confirm cancel"
              className={compactClass}
            >
              <X />
              {compact ? "Confirm" : "Confirm cancel"}
            </Button>
          ) : (
            <Button
              variant="destructive"
              size={buttonSize}
              disabled={busy}
              onClick={armConfirm}
              data-testid="run-controls-cancel"
              title="Cancel"
              className={compactClass}
            >
              <X />
              {!compact && "Cancel"}
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
