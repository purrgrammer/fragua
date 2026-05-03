// RunPausedNotice — banner rendered above the run-detail tabs when the
// run is in `paused`. Dispatches on the reason carried by the latest
// `fact.run_paused.payload.reason`:
//   operator         → "Run paused by operator." + Resume / Cancel
//   provider_error   → "<provider> returned <status>" + Resume / Cancel
//   payment_required → "<provider> reports payment required" + Resume / Cancel
//   budget           → "Budget reached: …" + numeric input + Raise & Resume / Resume / Cancel
//
// Hidden on `paused_hitl`-only pauses (no fact.run_paused in the trail).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { useId, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { adjustBudget, cancelRun, getRunEvents, resumeRun } from "@/lib/api";
import { queries } from "@/lib/queries";

export interface RunPausedNoticeProps {
  runId: string;
}

type PausePayload =
  | { reason: "operator"; nodeId: string }
  | {
      reason: "provider_error";
      nodeId: string;
      httpStatus: number | null;
      provider: string;
      errorMessage: string;
    }
  | {
      reason: "payment_required";
      nodeId: string;
      provider: string;
      errorMessage: string;
    }
  | {
      reason: "budget";
      nodeId: string;
      scope: "node" | "run";
      metric: "cost" | "tokens";
      limit: number;
      actual: number;
    };

interface FactRow {
  type?: unknown;
  payload?: unknown;
  seq?: unknown;
}

/** A run is "still paused" only if the latest run-state-changing fact in
 * the trail is `fact.run_paused`. Subsequent facts (run_resumed,
 * run_cancelled, run_completed, run_halted) mean the pause is no longer
 * the live state — even if the original paused fact is still in the
 * event log. Gate the notice on the latest fact, not the existence of
 * any paused fact. */
const RUN_STATE_FACTS = new Set([
  "fact.run_paused",
  "fact.run_paused_hitl",
  "fact.run_resumed",
  "fact.run_cancelled",
  "fact.run_completed",
  "fact.run_halted",
  "fact.run_quarantined",
]);

function findActivePause(events: readonly unknown[]): PausePayload | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as FactRow;
    if (typeof ev?.type !== "string") continue;
    if (!RUN_STATE_FACTS.has(ev.type)) continue;
    if (ev.type !== "fact.run_paused") return null;
    const p = ev.payload;
    if (p == null || typeof p !== "object") return null;
    return p as PausePayload;
  }
  return null;
}

/** Format the user-facing one-liner for provider_error pauses. pi-ai
 * surfaces upstream HTTP errors as a stream `error` event WITHOUT firing
 * `onResponse` first, so the agent backend captures `httpStatus=null` and
 * the verbatim provider text (e.g. `'500 "Internal Server Error"'`)
 * lands in `errorMessage`. We pull the status + reason out of that text
 * when we have to so the notice reads `<provider> returned 500 (Internal Server Error)`
 * — same shape as runs that DID land an `onResponse` payload. Provider
 * names render verbatim (no auto-capitalisation): user-configured
 * aliases keep the casing the operator chose. */
function formatProviderError(p: Extract<PausePayload, { reason: "provider_error" }>): string {
  const trimmed = p.errorMessage.trim();
  const statusInText = /^(\d{3})\s+["']?([^"']+?)["']?\s*$/.exec(trimmed);
  const status = p.httpStatus ?? (statusInText ? Number(statusInText[1]) : null);
  const reason = statusInText ? statusInText[2]!.trim() : trimmed;
  if (status != null) {
    return `${p.provider} returned ${status} (${reason})`;
  }
  return `${p.provider} network error: ${reason}`;
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

function pauseTitle(reason: PausePayload["reason"]): string {
  switch (reason) {
    case "operator":
      return "Paused by operator";
    case "provider_error":
      return "Provider error — paused";
    case "payment_required":
      return "Payment required — paused";
    case "budget":
      return "Budget reached — paused";
  }
}

function pauseBody(payload: PausePayload): string {
  switch (payload.reason) {
    case "operator":
      return "Run paused by operator. Resume to continue, or cancel to terminate.";
    case "provider_error":
      return formatProviderError(payload);
    case "payment_required":
      return `${payload.provider} reports payment required. Top up at the provider's console, then resume.`;
    case "budget": {
      const unit = payload.metric === "cost" ? "$" : "";
      return `Budget reached: ${payload.scope} ${payload.metric} ${unit}${payload.actual} ≥ ${unit}${payload.limit}.`;
    }
  }
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

  const adjustMutation = useMutation({
    mutationFn: (input: { scope: "node" | "run"; metric: "cost" | "tokens"; newLimit: number }) =>
      adjustBudget(runId, input.scope, input.metric, input.newLimit),
  });

  const payload = eventsQuery.data ? findActivePause(eventsQuery.data.events) : null;
  if (payload == null) return null;

  const busy = resumeMutation.isPending || cancelMutation.isPending || adjustMutation.isPending;
  const message = pauseBody(payload);

  return (
    <Alert variant="destructive" data-testid="run-paused-notice" data-pause-reason={payload.reason}>
      <AlertCircle />
      <AlertTitle>{pauseTitle(payload.reason)}</AlertTitle>
      <AlertDescription>
        <span data-testid="run-paused-message">{message}</span>
      </AlertDescription>
      {payload.reason === "budget" ? (
        <BudgetActions
          payload={payload}
          busy={busy}
          onCancel={() => cancelMutation.mutate()}
          onResume={() => resumeMutation.mutate()}
          onRaiseAndResume={async (newLimit) => {
            await adjustMutation.mutateAsync({ scope: payload.scope, metric: payload.metric, newLimit });
            resumeMutation.mutate();
          }}
        />
      ) : (
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
      )}
    </Alert>
  );
}

interface BudgetActionsProps {
  payload: Extract<PausePayload, { reason: "budget" }>;
  busy: boolean;
  onCancel: () => void;
  onResume: () => void;
  onRaiseAndResume: (newLimit: number) => Promise<void> | void;
}

function BudgetActions({ payload, busy, onCancel, onResume, onRaiseAndResume }: BudgetActionsProps): JSX.Element {
  const inputId = useId();
  const [draft, setDraft] = useState<string>(String(payload.limit));
  const parsed = Number(draft);
  // Any positive finite number is a valid adjustment. The operator may
  // submit the same limit (re-pause immediately) or a lower one (also
  // re-pauses); the protocol doesn't enforce monotonicity. The button
  // text "Raise & Resume" + the input min carry the UX nudge.
  const valid = Number.isFinite(parsed) && parsed > 0;
  return (
    <div className="col-start-2 mt-3 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sw-xs text-sw-muted">
        <label htmlFor={inputId} className="shrink-0">
          New {payload.metric} limit:
        </label>
        <input
          id={inputId}
          type="number"
          inputMode="decimal"
          step={payload.metric === "cost" ? "0.01" : "1"}
          min={payload.limit}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
          data-testid="run-paused-budget-input"
          className="w-32 rounded-sw-card border border-sw-border bg-sw-bg px-2 py-1 text-sw-text focus:outline-none"
        />
        <span className="text-sw-muted">(current {payload.limit})</span>
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel} data-testid="run-paused-cancel">
          Cancel
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onResume} data-testid="run-paused-resume">
          Resume as-is
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !valid}
          onClick={() => onRaiseAndResume(parsed)}
          data-testid="run-paused-raise-resume"
          title={valid ? `Raise to ${parsed} and resume` : "Enter a value greater than the current limit"}
        >
          Raise &amp; Resume
        </Button>
      </div>
    </div>
  );
}
