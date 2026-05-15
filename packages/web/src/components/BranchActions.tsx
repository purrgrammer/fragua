// Inline operator controls for a paused sub-run (branch). Renders a
// compact button row — Resume / Cancel / Manage. The full
// RunPausedNotice (Raise & Resume input for budget pauses, retry caps,
// etc.) lives on the child's detail page; "Manage →" opens it via
// `/runs/<childId>?orphan=true` (the escape hatch added by P6 of the
// sub-runs UI plan).
//
// Action buttons are intentionally minimal here — the parent's detail
// page is the operator's home base; sending them to the child page
// for budget edits keeps the parent surface uncluttered. Future:
// expose Raise & Resume inline once the panel-vs-popover tradeoff is
// settled.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cancelRun, type RunSummary, resumeRun } from "../lib/api.ts";
import { queries } from "../lib/queries.ts";
import { Button } from "./ui/button.tsx";

export interface BranchActionsProps {
  /** Sub-run id. Actions fire against this run, not the parent. */
  runId: string;
  /** Sub-run's lifecycle status — drives which actions render. */
  runStatus?: NonNullable<RunSummary["runStatus"]>;
  /** Parent's id so the "Manage →" link tracks home. */
  parentRunId?: string;
}

function isOperatorActionable(status?: NonNullable<RunSummary["runStatus"]>): boolean {
  return status === "paused" || status === "paused_hitl" || status === "quarantined";
}

export function BranchActions({ runId, runStatus, parentRunId }: BranchActionsProps): JSX.Element | null {
  const qc = useQueryClient();
  const resume = useMutation({
    mutationFn: () => resumeRun(runId),
    onSuccess: async () => {
      await qc.invalidateQueries(queries.runs.children(parentRunId ?? runId));
      await qc.invalidateQueries(queries.runs.detail(runId));
    },
  });
  const cancel = useMutation({
    mutationFn: () => cancelRun(runId),
    onSuccess: async () => {
      await qc.invalidateQueries(queries.runs.children(parentRunId ?? runId));
      await qc.invalidateQueries(queries.runs.detail(runId));
    },
  });
  if (!isOperatorActionable(runStatus)) return null;
  const busy = resume.isPending || cancel.isPending;
  return (
    <div data-testid={`branch-actions-${runId}`} data-run-status={runStatus} className="inline-flex items-center gap-1">
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => cancel.mutate()}
        data-testid={`branch-cancel-${runId}`}
      >
        Cancel
      </Button>
      {runStatus !== "paused_hitl" ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => resume.mutate()}
          data-testid={`branch-resume-${runId}`}
        >
          Resume
        </Button>
      ) : null}
    </div>
  );
}
