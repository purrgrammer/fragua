// RunPausedNotice — banner rendered above the run-detail tabs when the
// run is paused due to a provider transport error
// (`fact.run_paused_provider_error`). Shows the verbatim provider
// message + Resume / Cancel actions. Hidden on `paused_hitl`-only
// pauses (no provider-error fact in the trail).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cancelRun, getRunEvents, resumeRun } from "@/lib/api";
import { queries } from "@/lib/queries";

export interface RunPausedNoticeProps {
  runId: string;
}

interface ProviderErrorPayload {
  nodeId: string;
  httpStatus: number | null;
  provider: string;
  errorMessage: string;
}

interface FactRow {
  type?: unknown;
  payload?: unknown;
  seq?: unknown;
}

/** A run is "still paused on a provider error" only if the latest
 * run-state-changing fact in the trail is `fact.run_paused_provider_error`.
 * Subsequent facts (run_resumed, run_cancelled, run_completed, run_halted)
 * mean the pause is no longer the live state — even if the original
 * paused fact is still in the event log. Gate the notice on the latest
 * fact, not the existence of any paused fact. */
const RUN_STATE_FACTS = new Set([
  "fact.run_paused_provider_error",
  "fact.run_paused_hitl",
  "fact.run_resumed",
  "fact.run_cancelled",
  "fact.run_completed",
  "fact.run_halted",
  "fact.run_quarantined",
]);

function findActiveProviderError(events: readonly unknown[]): ProviderErrorPayload | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as FactRow;
    if (typeof ev?.type !== "string") continue;
    if (!RUN_STATE_FACTS.has(ev.type)) continue;
    if (ev.type !== "fact.run_paused_provider_error") return null;
    const p = ev.payload;
    if (p == null || typeof p !== "object") return null;
    const r = p as Record<string, unknown>;
    if (typeof r["errorMessage"] !== "string" || typeof r["provider"] !== "string") return null;
    return {
      nodeId: typeof r["nodeId"] === "string" ? r["nodeId"] : "",
      httpStatus: typeof r["httpStatus"] === "number" ? r["httpStatus"] : null,
      provider: r["provider"],
      errorMessage: r["errorMessage"],
    };
  }
  return null;
}

/** Format the user-facing one-liner. pi-ai surfaces upstream HTTP errors
 * as a stream `error` event WITHOUT firing `onResponse` first, so the
 * agent backend captures `httpStatus=null` and the verbatim provider
 * text (e.g. `'402 "Payment Required"'`) lands in `errorMessage`. We
 * pull the status + reason out of that text when we have to so the
 * notice reads `<provider> returned 402 (Payment Required)` — same
 * shape as runs that DID land an `onResponse` payload. Provider names
 * render verbatim (no auto-capitalisation): user-configured aliases
 * keep the casing the operator chose. */
function formatProviderError(e: ProviderErrorPayload): string {
  const trimmed = e.errorMessage.trim();
  const statusInText = /^(\d{3})\s+["']?([^"']+?)["']?\s*$/.exec(trimmed);
  const status = e.httpStatus ?? (statusInText ? Number(statusInText[1]) : null);
  const reason = statusInText ? statusInText[2]!.trim() : trimmed;
  if (status != null) {
    return `${e.provider} returned ${status} (${reason})`;
  }
  return `${e.provider} network error: ${reason}`;
}

/** Belt-and-suspenders refresh after a control-plane mutation. The
 * daemon picks up the intent on its next poll tick (~100ms); SSE pushes
 * the resulting fact and `useDetailOverlay` flips status without a
 * refetch. The two refetches below are a fallback for the SSE-doesn't-
 * land path: stale-mark immediately so any observer refetches, then
 * force-refetch after a short delay to catch the daemon's emitted fact
 * if SSE was hiccupping. Idempotent — extra refetches are cheap. */
async function refreshAfterControl(qc: ReturnType<typeof useQueryClient>, runId: string): Promise<void> {
  await qc.invalidateQueries(queries.runs.detail(runId));
  await qc.invalidateQueries({ queryKey: ["run-paused-events", runId] });
  await new Promise((r) => setTimeout(r, 350));
  await qc.refetchQueries(queries.runs.detail(runId));
  await qc.refetchQueries({ queryKey: ["run-paused-events", runId] });
}

export function RunPausedNotice({ runId }: RunPausedNoticeProps): JSX.Element | null {
  const qc = useQueryClient();
  const eventsQuery = useQuery({
    queryKey: ["run-paused-events", runId],
    queryFn: () => getRunEvents(runId),
    enabled: !!runId,
    staleTime: 5_000,
  });

  const resumeMutation = useMutation({
    mutationFn: () => resumeRun(runId),
    onSuccess: () => refreshAfterControl(qc, runId),
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelRun(runId),
    onSuccess: () => refreshAfterControl(qc, runId),
  });

  const providerError = eventsQuery.data ? findActiveProviderError(eventsQuery.data.events) : null;
  if (providerError == null) return null;

  const busy = resumeMutation.isPending || cancelMutation.isPending;
  const message = formatProviderError(providerError);

  return (
    <Alert variant="destructive" data-testid="run-paused-notice">
      <AlertCircle />
      <AlertTitle>Provider error — paused</AlertTitle>
      <AlertDescription>
        <span data-testid="run-paused-message">{message}</span>
      </AlertDescription>
      <div className="col-start-2 mt-3 flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => cancelMutation.mutate()}
          data-testid="run-paused-cancel"
        >
          Cancel
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => resumeMutation.mutate()}
          data-testid="run-paused-resume"
        >
          Resume
        </Button>
      </div>
    </Alert>
  );
}
