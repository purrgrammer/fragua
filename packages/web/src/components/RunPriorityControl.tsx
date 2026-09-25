// RunPriorityControl — inline priority adjuster for a still-queued run.
//
// Priority only re-orders the dispatch queue (higher dispatches first), so it
// self-hides once the run has left `queued`. Web equivalent of
// `fragua runs priority`. Returns null when not applicable so callers can
// mount it unconditionally in the header.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { adjustPriority, type RunDetail } from "../lib/api.ts";
import { queries } from "../lib/queries.ts";
import { toast, toastError } from "../lib/toast.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";

export interface RunPriorityControlProps {
  runId: string;
  status: RunDetail["status"];
  priority?: number;
  imported?: boolean;
}

export function RunPriorityControl({
  runId,
  status,
  priority = 0,
  imported = false,
}: RunPriorityControlProps): JSX.Element | null {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string>(String(priority));
  // The prop moves under us when an SSE push or a CLI `runs priority` lands
  // while the run is on screen. Without this the input keeps showing the old
  // value and Set stays enabled, so a click silently reverts the change.
  useEffect(() => setDraft(String(priority)), [priority]);

  const adjustM = useMutation({
    mutationFn: (newPriority: number) => adjustPriority(runId, newPriority),
    onSuccess: (_, newPriority) => {
      toast.success(`Priority set to ${newPriority}`);
      return qc.invalidateQueries(queries.runs.detail(runId));
    },
    onError: (err) => toastError(err),
  });

  if (imported || status !== "queued") return null;

  const parsed = Number(draft);
  const valid = Number.isInteger(parsed) && parsed !== priority;

  return (
    <form
      className="flex items-center gap-1 text-sw-text"
      data-testid="run-priority-control"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) adjustM.mutate(parsed);
      }}
    >
      <label htmlFor={`run-priority-${runId}`} className="text-[0.65rem] uppercase tracking-[0.06em] text-sw-muted">
        priority
      </label>
      <Input
        id={`run-priority-${runId}`}
        type="number"
        inputMode="numeric"
        step="1"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={adjustM.isPending}
        data-testid="run-priority-input"
        className="h-5 w-16 px-1.5 text-[0.65rem]"
      />
      <Button
        type="submit"
        variant="outline"
        size="xs"
        disabled={adjustM.isPending || !valid}
        data-testid="run-priority-set"
        title="Set priority"
        className="h-5 px-1.5 text-[0.65rem]"
      >
        Set
      </Button>
    </form>
  );
}
