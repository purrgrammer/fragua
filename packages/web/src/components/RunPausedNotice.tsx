// RunPausedNotice — banner rendered above the run-detail tabs when the
// run is in `paused` or `paused_auto`. Dispatches on the reason carried
// by the latest `fact.run_paused.payload.reason` via an exhaustive
// `Renderers` map keyed by `PauseReason`. Adding a literal to
// `PauseReason` (in `@fragua/types`) without a renderer entry below
// forces a TypeScript compile error here — the design's exhaustiveness
// anchor.
//
// Hidden on `paused_human`-only pauses (no fact.run_paused in the trail).

import type { PauseReason } from "@fragua/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { CancelRunDialog } from "@/components/CancelRunDialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  adjustBudget,
  adjustGoalGate,
  adjustMaxLoops,
  adjustMaxRetries,
  cancelRun,
  getRunEvents,
  resumeRun,
} from "@/lib/api";
import { queries } from "@/lib/queries";
import { toast, toastError } from "@/lib/toast";

export interface RunPausedNoticeProps {
  runId: string;
  /** Bumps once per SSE frame (the parent's `totalEvents`). Folded into the
   * events query key so the notice refetches when the pause fact lands —
   * without it the separate query can serve pre-pause events and render
   * nothing until a manual refresh. */
  eventEpoch?: number;
  /** When true the run was brought in via `fragua import`. All pause/halt
   * banners render in strictly-informational mode — reason text only,
   * no action buttons (Resume, Cancel, Raise budget, etc.). */
  imported?: boolean;
}

/** Pauses that are genuine errors / wedged states get the destructive
 * (red) treatment. Expected gates — operator stops, budget ceilings, auto
 * retries, cap exhaustion — are routine control-plane events, not failures,
 * so they render on the neutral surface. */
const DESTRUCTIVE_REASONS = new Set<PauseReason>([
  "provider_error",
  "payment_required",
  "abort_loop",
  "provider_exhausted",
  "engine_incompatible",
]);

/** Budget amounts: cost to exactly 2 decimals with a `$`, tokens as a
 * grouped integer. Anything more precise is noise in the UI. */
function formatBudgetAmount(metric: "cost" | "tokens", value: number): string {
  return metric === "cost" ? `$${value.toFixed(2)}` : value.toLocaleString();
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
    }
  | {
      reason: "timeout_retry";
      nodeId: string;
      attempt: number;
      delayMs: number;
      resumeAt: number;
      maxAttempts: number;
      attemptedMs: number;
    }
  | { reason: "max_retries"; nodeId: string; currentLimit: number; attempts: number }
  | { reason: "goal_gate"; gateNodeId: string; currentLimit: number }
  | { reason: "max_loops"; currentLimit: number; dispatches: number }
  | { reason: "abort_loop"; nodeId: string; consecutiveAborts: number }
  | { reason: "provider_exhausted"; nodeId: string; attempts: number; cumulativeMs: number }
  | { reason: "engine_incompatible"; pinnedVersion: number; supportedMin: number; supportedMax: number };

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
  "fact.run_paused_human",
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
  onAdjustMaxRetries: (input: { nodeId: string; newLimit: number }) => Promise<void>;
  onAdjustGoalGate: (input: { newLimit: number }) => Promise<void>;
  onAdjustMaxLoops: (input: { newLimit: number }) => Promise<void>;
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
 * `@fragua/types` without an entry here is a TypeScript compile error
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
  const isCost = payload.metric === "cost";
  const [draft, setDraft] = useState<string>(isCost ? payload.limit.toFixed(2) : String(payload.limit));
  const parsed = Number(draft);
  // Any positive finite number is a valid adjustment. The operator may
  // submit the same limit (re-pause immediately) or a lower one (also
  // re-pauses); the protocol doesn't enforce monotonicity. The button
  // text "Raise & Resume" + the input min carry the UX nudge.
  const valid = Number.isFinite(parsed) && parsed > 0;
  return (
    <div className="col-start-2 mt-3 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sw-xs text-sw-muted">
        <label htmlFor={inputId} className="shrink-0">
          New {payload.metric} limit
        </label>
        <Input
          id={inputId}
          type="number"
          inputMode="decimal"
          step={isCost ? "0.01" : "1"}
          min={payload.limit}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
          data-testid="run-paused-budget-input"
          className="w-28"
        />
        <span>current {formatBudgetAmount(payload.metric, payload.limit)}</span>
      </div>
      <div className="flex gap-2">
        <Button
          variant="default"
          size="sm"
          disabled={busy || !valid}
          onClick={async () => {
            await onAdjustBudget({ scope: payload.scope, metric: payload.metric, newLimit: parsed });
            onResume();
          }}
          data-testid="run-paused-raise-resume"
          title={
            valid
              ? `Raise to ${formatBudgetAmount(payload.metric, parsed)} and resume`
              : "Enter a value greater than the current limit"
          }
        >
          Raise &amp; resume
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onResume} data-testid="run-paused-resume">
          Resume as-is
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel} data-testid="run-paused-cancel">
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Generic Raise & Resume / Resume / Cancel action set for sibling-
 * halt pauses (max_retries, goal_gate, max_loops). The label /
 * unit / step are caller-supplied; the underlying intent fires via
 * the supplied async callback. Mirrors BudgetActions' layout for
 * visual consistency. */
function CapAdjustActions({
  busy,
  currentLimit,
  unit,
  onCancel,
  onResume,
  onAdjust,
}: {
  busy: boolean;
  currentLimit: number;
  unit: string;
  onCancel: () => void;
  onResume: () => void;
  onAdjust: (newLimit: number) => Promise<void>;
}): JSX.Element {
  const inputId = useId();
  const [draft, setDraft] = useState<string>(String(currentLimit));
  const parsed = Number(draft);
  const valid = Number.isFinite(parsed) && parsed > 0;
  return (
    <div className="col-start-2 mt-3 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sw-xs text-sw-muted">
        <label htmlFor={inputId} className="shrink-0">
          New {unit} limit
        </label>
        <Input
          id={inputId}
          type="number"
          inputMode="numeric"
          step="1"
          min={currentLimit}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
          data-testid="run-paused-cap-input"
          className="w-28"
        />
        <span>current {currentLimit.toLocaleString()}</span>
      </div>
      <div className="flex gap-2">
        <Button
          variant="default"
          size="sm"
          disabled={busy || !valid}
          onClick={async () => {
            await onAdjust(parsed);
            onResume();
          }}
          data-testid="run-paused-raise-resume"
          title={valid ? `Raise to ${parsed} and resume` : "Enter a value greater than the current limit"}
        >
          Raise &amp; resume
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onResume} data-testid="run-paused-resume">
          Resume as-is
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel} data-testid="run-paused-cancel">
          Cancel
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

function TimeoutRetryBody({ payload }: { payload: Extract<PausePayload, { reason: "timeout_retry" }> }): JSX.Element {
  const eta = useCountdownToResume(payload.resumeAt);
  const minutes = Math.round(payload.attemptedMs / 60_000);
  const human = minutes >= 1 ? `${minutes}m` : `${Math.round(payload.attemptedMs / 1_000)}s`;
  return (
    <span data-testid="run-paused-message">
      Watchdog fired on node {payload.nodeId} after {human}; retrying {eta} (attempt {payload.attempt}/
      {payload.maxAttempts}). Transcript preserved; resume to short-circuit the wait.
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
    return {
      title: "Budget reached — paused",
      body: (
        <span data-testid="run-paused-message">
          {payload.scope} {payload.metric} reached {formatBudgetAmount(payload.metric, payload.actual)} of{" "}
          {formatBudgetAmount(payload.metric, payload.limit)}. Raise the limit to continue.
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
  timeout_retry: ({ payload, ctx }) => ({
    title: "Watchdog — retrying",
    body: <TimeoutRetryBody payload={payload} />,
    actions: (
      <ResumeCancelActions busy={ctx.busy} onResume={ctx.onResume} onCancel={ctx.onCancel} resumeLabel="Resume now" />
    ),
  }),
  max_retries: ({ payload, ctx }) => ({
    title: "Retries exhausted — paused",
    body: (
      <span data-testid="run-paused-message">
        Node {payload.nodeId} exhausted {payload.attempts} of {payload.currentLimit} retries. Resume grants one more
        attempt; raise the cap to grant several.
      </span>
    ),
    actions: (
      <CapAdjustActions
        busy={ctx.busy}
        currentLimit={payload.currentLimit}
        unit="max_retries"
        onCancel={ctx.onCancel}
        onResume={ctx.onResume}
        onAdjust={(newLimit) => ctx.onAdjustMaxRetries({ nodeId: payload.nodeId, newLimit })}
      />
    ),
  }),
  goal_gate: ({ payload, ctx }) => ({
    title: "Goal gate unsatisfied — paused",
    body: (
      <span data-testid="run-paused-message">
        Gate {payload.gateNodeId} failed after {payload.currentLimit} retarget cycles. Resume grants one more cycle;
        raise the cap to grant several.
      </span>
    ),
    actions: (
      <CapAdjustActions
        busy={ctx.busy}
        currentLimit={payload.currentLimit}
        unit="max_goal_gate_retries"
        onCancel={ctx.onCancel}
        onResume={ctx.onResume}
        onAdjust={(newLimit) => ctx.onAdjustGoalGate({ newLimit })}
      />
    ),
  }),
  max_loops: ({ payload, ctx }) => ({
    title: "Dispatch ceiling — paused",
    body: (
      <span data-testid="run-paused-message">
        Run exceeded {payload.currentLimit} dispatches ({payload.dispatches} so far). Resume grants a fresh batch at the
        same cap; raise the cap to permanently extend the ceiling.
      </span>
    ),
    actions: (
      <CapAdjustActions
        busy={ctx.busy}
        currentLimit={payload.currentLimit}
        unit="max_loops"
        onCancel={ctx.onCancel}
        onResume={ctx.onResume}
        onAdjust={(newLimit) => ctx.onAdjustMaxLoops({ newLimit })}
      />
    ),
  }),
  abort_loop: ({ payload, ctx }) => ({
    title: "Abort loop — paused",
    body: (
      <span data-testid="run-paused-message">
        Node {payload.nodeId} aborted {payload.consecutiveAborts} consecutive times. Resume to retry once, or cancel if
        the node is wedged.
      </span>
    ),
    actions: <ResumeCancelActions busy={ctx.busy} onResume={ctx.onResume} onCancel={ctx.onCancel} />,
  }),
  provider_exhausted: ({ payload, ctx }) => ({
    title: "Provider chain exhausted — paused",
    body: (
      <span data-testid="run-paused-message">
        Provider chain exhausted after {payload.attempts} attempts. Resume to start a fresh chain (operator may have
        fixed the underlying transport issue), or cancel.
      </span>
    ),
    actions: <ResumeCancelActions busy={ctx.busy} onResume={ctx.onResume} onCancel={ctx.onCancel} />,
  }),
  engine_incompatible: ({ payload, ctx }) => {
    const tooNew = payload.pinnedVersion > payload.supportedMax;
    return {
      title: tooNew ? "Engine too old — paused" : "Run too old — paused",
      body: (
        <span data-testid="run-paused-message">
          {tooNew ? (
            <>
              This run is pinned to version {payload.pinnedVersion}, newer than this daemon folds (max{" "}
              {payload.supportedMax}). Upgrade the daemon and resume, or cancel.
            </>
          ) : (
            <>
              This run is pinned to version {payload.pinnedVersion}, below this daemon's minimum ({payload.supportedMin}
              ). It can't resume as-is — rebuild it from source, or cancel.
            </>
          )}
        </span>
      ),
      actions: <ResumeCancelActions busy={ctx.busy} onResume={ctx.onResume} onCancel={ctx.onCancel} />,
    };
  },
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

export function RunPausedNotice({ runId, eventEpoch = 0, imported = false }: RunPausedNoticeProps): JSX.Element | null {
  const qc = useQueryClient();
  const eventsQuery = useQuery({
    // `eventEpoch` (parent's SSE frame counter) is in the key so a pause
    // fact landing live forces a refetch — the notice mounts the moment the
    // overlay flips to paused, and this guarantees it reads the fresh trail
    // rather than a cached pre-pause one. While paused no frames arrive, so
    // the key is stable and we don't refetch in a loop.
    queryKey: ["run-paused-events", runId, eventEpoch],
    queryFn: () => getRunEvents(runId),
    enabled: !!runId,
    staleTime: 5_000,
  });

  const resumeMutation = useMutation({
    mutationFn: () => resumeRun(runId),
    onSuccess: () => {
      toast.success("Run resumed");
      return refreshAfterControl(qc, runId);
    },
    onError: (err) => toastError(err),
  });

  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  const cancelMutation = useMutation({
    mutationFn: (reason?: string) => cancelRun(runId, reason),
    onSuccess: () => {
      toast.success("Run cancelled");
      return refreshAfterControl(qc, runId);
    },
    onError: (err) => toastError(err),
  });

  const adjustBudgetMutation = useMutation({
    mutationFn: (input: { scope: "node" | "run"; metric: "cost" | "tokens"; newLimit: number }) =>
      adjustBudget(runId, input.scope, input.metric, input.newLimit),
    onSuccess: (_, input) => {
      const label =
        input.metric === "cost"
          ? formatBudgetAmount("cost", input.newLimit)
          : `${input.newLimit.toLocaleString()} tokens`;
      toast.success(`Budget raised to ${label}`);
    },
    onError: (err) => toastError(err),
  });
  const adjustMaxRetriesMutation = useMutation({
    mutationFn: (input: { nodeId: string; newLimit: number }) => adjustMaxRetries(runId, input.nodeId, input.newLimit),
    onSuccess: (_, input) => toast.success(`Max retries set to ${input.newLimit}`),
    onError: (err) => toastError(err),
  });
  const adjustGoalGateMutation = useMutation({
    mutationFn: (input: { newLimit: number }) => adjustGoalGate(runId, input.newLimit),
    onSuccess: (_, input) => toast.success(`Goal gate set to ${input.newLimit}`),
    onError: (err) => toastError(err),
  });
  const adjustMaxLoopsMutation = useMutation({
    mutationFn: (input: { newLimit: number }) => adjustMaxLoops(runId, input.newLimit),
    onSuccess: (_, input) => toast.success(`Max loops set to ${input.newLimit}`),
    onError: (err) => toastError(err),
  });

  const payload = eventsQuery.data ? findActivePause(eventsQuery.data.events) : null;
  if (payload == null) return null;

  const busy =
    resumeMutation.isPending ||
    cancelMutation.isPending ||
    adjustBudgetMutation.isPending ||
    adjustMaxRetriesMutation.isPending ||
    adjustGoalGateMutation.isPending ||
    adjustMaxLoopsMutation.isPending;
  const ctx: RenderCtx = {
    busy,
    onResume: () => resumeMutation.mutate(),
    onCancel: () => setCancelDialogOpen(true),
    onAdjustBudget: async (input) => {
      await adjustBudgetMutation.mutateAsync(input);
    },
    onAdjustMaxRetries: async (input) => {
      await adjustMaxRetriesMutation.mutateAsync(input);
    },
    onAdjustGoalGate: async (input) => {
      await adjustGoalGateMutation.mutateAsync(input);
    },
    onAdjustMaxLoops: async (input) => {
      await adjustMaxLoopsMutation.mutateAsync(input);
    },
  };
  const { title, body, actions } = renderPause(payload, ctx);

  const variant = DESTRUCTIVE_REASONS.has(payload.reason) ? "destructive" : "default";
  return (
    <>
      <Alert variant={variant} data-testid="run-paused-notice" data-pause-reason={payload.reason}>
        <AlertCircle />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{body}</AlertDescription>
        {!imported && actions}
      </Alert>
      {!imported && (
        <CancelRunDialog
          open={cancelDialogOpen}
          onOpenChange={setCancelDialogOpen}
          onConfirm={(reason) => cancelMutation.mutate(reason)}
          showReason={false}
        />
      )}
    </>
  );
}
