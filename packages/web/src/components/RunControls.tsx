// RunControls — operator-driven Pause / Resume / Cancel for a run.
//
// Specialized banners own the action for their substatus:
//   - paused                → RunPausedNotice (Resume + Cancel; budget reason has Raise & Resume)
//   - paused_human           → HitlChoice (option buttons)
// RunControls handles the "everything else" surface: generic operator
// pause, resume of an operator-paused run, and cancel-from-anywhere on
// non-terminal runs. Returns null when no action applies (terminal
// runs, or when a specialized banner already owns every action).

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, X } from "lucide-react";
import { useState } from "react";
import { cancelRun, pauseRun, type RunDetail, resumeRun } from "../lib/api.ts";
import { queries } from "../lib/queries.ts";
import { toast, toastError } from "../lib/toast.ts";
import { CancelRunDialog } from "./CancelRunDialog.tsx";
import { ImportedBadge } from "./ImportedBadge.tsx";
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
   * controls can sit inline alongside the badge in a header row. */
  compact?: boolean;
  /** When true the run was brought in via `fragua import`. The daemon will
   * never dispatch it, so operate controls are replaced with an
   * `ImportedBadge` (inspect-only indicator). */
  imported?: boolean;
}

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

  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  if (imported) {
    return <ImportedBadge />;
  }

  const canPause = status === "running";
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
    resumeM.error instanceof Error
      ? resumeM.error.message
      : pauseM.error instanceof Error
        ? pauseM.error.message
        : null;

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
        {canCancel && (
          <Button
            variant="destructive"
            size={buttonSize}
            disabled={busy}
            onClick={() => setCancelDialogOpen(true)}
            data-testid="run-controls-cancel"
            title="Cancel"
            className={compactClass}
          >
            <X />
            {!compact && "Cancel"}
          </Button>
        )}
      </div>

      {errorMessage && (
        <p className="text-sw-xs text-sw-danger" data-testid="run-controls-error">
          {errorMessage}
        </p>
      )}

      {canCancel && (
        <CancelRunDialog
          open={cancelDialogOpen}
          onOpenChange={setCancelDialogOpen}
          onConfirm={(reason) => cancelM.mutate(reason)}
        />
      )}
    </div>
  );
}
