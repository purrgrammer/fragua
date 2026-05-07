// RunPausedNotice — banner rendered above the run-detail tabs when the
// run is in `paused` or `paused_auto`. Dispatches on the reason carried
// by the latest `fact.run_paused.payload.reason` via an exhaustive
// `Renderers` map keyed by `PauseReason`. Adding a literal to
// `PauseReason` (in `@swarm/types`) without a renderer entry below
// forces a TypeScript compile error here — the design's exhaustiveness
// anchor.
//
// Hidden on `paused_hitl`-only pauses (no fact.run_paused in the trail).

import type { PauseReason } from "@swarm/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
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
    }
  | {
      reason: "provider_retry";
      nodeId: string;
      httpStatus: number | null;
      provider: string;
      errorMessage: string;
      attempt: number;
      resumeAt: number;
    }
  | {
      reason: "handler_retry";
      nodeId: string;
      attempt: number;
      delayMs: number;
      resumeAt: number;
      maxRetries: number;
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
function formatProviderError(p: { httpStatus: number | null; provider: string; errorMessage: string }): string {
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

// ─── Renderer contract ─────────────────────────────────────────────

interface RenderCtx {
  busy: boolean;
  onResume: () => void;
  onCancel: () => void;
  onAdjustBudget: (input: { scope: "node" | "run"; metric: "cost" | "tokens"; newLimit: number }) => Promise<void>;
}

interface RenderOutput {
  title: string;
  body: ReactNode;
  actions: ReactNode;
}

type Renderer<K extends PauseReason> = (input: {
  payload: Extract<PausePayload, { reason: K }>;
  ctx: RenderCtx;
}) => RenderOutput;

/** Exhaustiveness anchor. Adding a `PauseReason` literal in
 * `@swarm/types` without an entry here is a TypeScript compile error
 * at this object literal — the design's "no UI body branch goes
 * missing" guarantee. */
type Renderers = { [K in PauseReason]: Renderer<K> };

// ─── Reusable action sets ──────────────────────────────────────────

function ResumeCancelActions({
  busy,
  onResume,
  onCancel,
  resumeLabel = "Resume",
}: {
  busy: boolean;
  onResume: () => void;
  onCancel: () => void;
  resumeLabel?: string;
}): JSX.Element {
  return (
    <div className="col-start-2 mt-3 flex gap-2">
      <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel} data-testid="run-paused-cancel">
        Cancel
      </Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={onResume} data-testid="run-paused-resume">
        {resumeLabel}
      </Button>
    </div>
  );
}

function BudgetActions({
  payload,
  busy,
  onCancel,
  onResume,
  onAdjustBudget,
}: {
  payload: Extract<PausePayload, { reason: "budget" }>;
  busy: boolean;
  onCancel: () => void;
  onResume: () => void;
  onAdjustBudget: RenderCtx["onAdjustBudget"];
}): JSX.Element {
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
          onClick={async () => {
            await onAdjustBudget({ scope: payload.scope, metric: payload.metric, newLimit: parsed });
            onResume();
          }}
          data-testid="run-paused-raise-resume"
          title={valid ? `Raise to ${parsed} and resume` : "Enter a value greater than the current limit"}
        >
          Raise &amp; Resume
        </Button>
      </div>
    </div>
  );
}

// ─── Auto-wake countdown ───────────────────────────────────────────

/** Live "in <N>s" string ticking off `resumeAt` once a second. Updates
 * stop after `resumeAt` is in the past — no point ticking past zero,
 * the wake-pending sweeper is a beat away from re-queuing. */
function useCountdownToResume(resumeAt: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const remaining = resumeAt - now;
    if (remaining <= 0) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [resumeAt, now]);
  const remainingMs = resumeAt - now;
  if (remainingMs <= 0) return "now";
  const seconds = Math.ceil(remainingMs / 1_000);
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `in ${minutes}m`;
}

function ProviderRetryBody({ payload }: { payload: Extract<PausePayload, { reason: "provider_retry" }> }): JSX.Element {
  const eta = useCountdownToResume(payload.resumeAt);
  const errLabel = formatProviderError(payload);
  return (
    <span data-testid="run-paused-message">
      {errLabel}; retrying {eta} (attempt {payload.attempt}). Resume to short-circuit the wait.
    </span>
  );
}

function HandlerRetryBody({ payload }: { payload: Extract<PausePayload, { reason: "handler_retry" }> }): JSX.Element {
  const eta = useCountdownToResume(payload.resumeAt);
  return (
    <span data-testid="run-paused-message">
      Node {payload.nodeId} retrying {eta} (attempt {payload.attempt}/{payload.maxRetries}). Resume to short-circuit the
      wait.
    </span>
  );
}

// ─── Renderer table ────────────────────────────────────────────────

const RENDERERS: Renderers = {
  operator: ({ payload: _payload, ctx }) => ({
    title: "Paused by operator",
    body: (
      <span data-testid="run-paused-message">Run paused by operator. Resume to continue, or cancel to terminate.</span>
    ),
    actions: <ResumeCancelActions busy={ctx.busy} onResume={ctx.onResume} onCancel={ctx.onCancel} />,
  }),
  provider_error: ({ payload, ctx }) => ({
    title: "Provider error — paused",
    body: <span data-testid="run-paused-message">{formatProviderError(payload)}</span>,
    actions: <ResumeCancelActions busy={ctx.busy} onResume={ctx.onResume} onCancel={ctx.onCancel} />,
  }),
  payment_required: ({ payload, ctx }) => ({
    title: "Payment required — paused",
    body: (
      <span data-testid="run-paused-message">
        {payload.provider} reports payment required. Top up at the provider's console, then resume.
      </span>
    ),
    actions: <ResumeCancelActions busy={ctx.busy} onResume={ctx.onResume} onCancel={ctx.onCancel} />,
  }),
  budget: ({ payload, ctx }) => {
    const unit = payload.metric === "cost" ? "$" : "";
    return {
      title: "Budget reached — paused",
      body: (
        <span data-testid="run-paused-message">
          Budget reached: {payload.scope} {payload.metric} {unit}
          {payload.actual} ≥ {unit}
          {payload.limit}.
        </span>
      ),
      actions: (
        <BudgetActions
          payload={payload}
          busy={ctx.busy}
          onCancel={ctx.onCancel}
          onResume={ctx.onResume}
          onAdjustBudget={ctx.onAdjustBudget}
        />
      ),
    };
  },
  provider_retry: ({ payload, ctx }) => ({
    title: "Provider retry — auto",
    body: <ProviderRetryBody payload={payload} />,
    actions: (
      <ResumeCancelActions busy={ctx.busy} onResume={ctx.onResume} onCancel={ctx.onCancel} resumeLabel="Resume now" />
    ),
  }),
  handler_retry: ({ payload, ctx }) => ({
    title: "Retrying — auto",
    body: <HandlerRetryBody payload={payload} />,
    actions: (
      <ResumeCancelActions busy={ctx.busy} onResume={ctx.onResume} onCancel={ctx.onCancel} resumeLabel="Resume now" />
    ),
  }),
};

/** Dispatch a payload through the exhaustive renderer table. The
 * `as never` cast is local to this lookup — TypeScript can't narrow
 * `RENDERERS[payload.reason]` across the discriminated union without
 * the operand being `never`-typed itself. The exhaustiveness signal
 * lives on the `Renderers` Record above. */
function renderPause(payload: PausePayload, ctx: RenderCtx): RenderOutput {
  const renderer = RENDERERS[payload.reason] as Renderer<typeof payload.reason>;
  return renderer({ payload: payload as never, ctx });
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
  const ctx: RenderCtx = {
    busy,
    onResume: () => resumeMutation.mutate(),
    onCancel: () => cancelMutation.mutate(),
    onAdjustBudget: async (input) => {
      await adjustMutation.mutateAsync(input);
    },
  };
  const { title, body, actions } = renderPause(payload, ctx);

  return (
    <Alert variant="destructive" data-testid="run-paused-notice" data-pause-reason={payload.reason}>
      <AlertCircle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{body}</AlertDescription>
      {actions}
    </Alert>
  );
}
