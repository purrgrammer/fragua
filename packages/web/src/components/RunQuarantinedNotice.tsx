// RunQuarantinedNotice — banner rendered above the run-detail tabs when the
// run is `quarantined`. The startup sweep found a `fact.side_effect_intent`
// without a matching `_done`/`_failed` (a crash between the two) and froze the
// run for operator review — no blind retry. The banner explains the quarantine
// reason, lists the orphaned intent seqs, and offers the THREE resolutions the
// intent plane / `runs unquarantine` verb accept, each as an operator action.
//
// `REASON_LABELS` is keyed by `QuarantineReason` so adding a literal to that
// union in `@fragua/types` without a label here is a TypeScript compile error
// — the same exhaustiveness anchor the pause/halt notices use.

import type { QuarantineReason } from "@fragua/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getRunEvents, unquarantineRun } from "@/lib/api";
import { queries } from "@/lib/queries";
import { toast, toastError } from "@/lib/toast";

export interface RunQuarantinedNoticeProps {
  runId: string;
  /** Bumps once per SSE frame (the parent's `totalEvents`). Folded into the
   * events query key so the notice refetches when the quarantine fact lands —
   * mirrors RunPausedNotice's eventEpoch. */
  eventEpoch?: number;
  /** When true the run was brought in via `fragua import` — render in
   * strictly-informational mode (reason + orphans only, no action buttons). */
  imported?: boolean;
}

const REASON_LABELS: Record<QuarantineReason, string> = {
  orphan_side_effect: "Orphaned side effect",
  other: "Quarantined",
};

/** The three resolutions `intent.unquarantine` accepts, in the order an
 * operator weighs them: assume the side effect landed, re-run it, or give up.
 * Exhaustiveness is pinned by the `resolution` arg type on `unquarantineRun`. */
const RESOLUTIONS: ReadonlyArray<{
  resolution: "treat_as_done" | "retry" | "cancel";
  label: string;
  hint: string;
  variant: "default" | "outline" | "ghost";
}> = [
  {
    resolution: "treat_as_done",
    label: "Treat as done",
    hint: "Assume the side effect completed; synthesise the missing result and resume.",
    variant: "default",
  },
  {
    resolution: "retry",
    label: "Retry",
    hint: "Re-run the orphaned side effect, then resume.",
    variant: "outline",
  },
  {
    resolution: "cancel",
    label: "Cancel run",
    hint: "Abandon the run without resuming.",
    variant: "ghost",
  },
];

interface FactRow {
  type?: unknown;
  payload?: unknown;
}

interface QuarantineInfo {
  reason: QuarantineReason;
  orphanedIntents: number[];
}

/** A run is "still quarantined" only if the latest run-state-changing fact is
 * `fact.run_quarantined`. A later resume/terminate means the quarantine was
 * resolved — gate on the latest fact, not the mere existence of the fact. */
const RUN_STATE_FACTS = new Set(["fact.run_quarantined", "fact.run_resumed", "fact.run_terminated", "fact.run_paused"]);

function findActiveQuarantine(events: readonly unknown[]): QuarantineInfo | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as FactRow;
    if (typeof ev?.type !== "string") continue;
    if (!RUN_STATE_FACTS.has(ev.type)) continue;
    if (ev.type !== "fact.run_quarantined") return null;
    const p = ev.payload;
    if (p == null || typeof p !== "object") return { reason: "other", orphanedIntents: [] };
    const reason = (p as { reason?: unknown }).reason;
    const orphans = (p as { orphanedIntents?: unknown }).orphanedIntents;
    return {
      reason: reason === "orphan_side_effect" || reason === "other" ? reason : "other",
      orphanedIntents: Array.isArray(orphans) ? orphans.filter((s): s is number => typeof s === "number") : [],
    };
  }
  return null;
}

export function RunQuarantinedNotice({
  runId,
  eventEpoch = 0,
  imported = false,
}: RunQuarantinedNoticeProps): JSX.Element | null {
  const qc = useQueryClient();
  const eventsQuery = useQuery({
    queryKey: ["run-quarantined-events", runId, eventEpoch],
    queryFn: () => getRunEvents(runId),
    enabled: !!runId,
    staleTime: 5_000,
  });

  const unquarantineMutation = useMutation({
    mutationFn: (resolution: "treat_as_done" | "retry" | "cancel") => unquarantineRun(runId, resolution),
    onSuccess: async (_data, resolution) => {
      toast.success(resolution === "cancel" ? "Run cancelled" : "Run unquarantined");
      await qc.invalidateQueries(queries.runs.detail(runId));
      await qc.invalidateQueries({ queryKey: ["run-quarantined-events", runId] });
      await new Promise((r) => setTimeout(r, 350));
      await qc.refetchQueries(queries.runs.detail(runId));
      await qc.refetchQueries({ queryKey: ["run-quarantined-events", runId] });
    },
    onError: (err) => toastError(err),
  });

  const info = eventsQuery.data ? findActiveQuarantine(eventsQuery.data.events) : null;
  if (info == null) return null;

  const busy = unquarantineMutation.isPending;
  const label = REASON_LABELS[info.reason];

  return (
    <Alert variant="destructive" data-testid="run-quarantined-notice" data-quarantine-reason={info.reason}>
      <ShieldAlert />
      <AlertTitle>{`Run quarantined — ${label.toLowerCase()}`}</AlertTitle>
      <AlertDescription>
        <span data-testid="run-quarantined-message">
          {info.reason === "orphan_side_effect"
            ? "A crash left a side effect without a recorded result. The run is frozen for review — resolve it to continue, no blind retry."
            : "The run was quarantined for operator review. Resolve it to continue."}
        </span>
        {info.orphanedIntents.length > 0 ? (
          <span
            data-testid="run-quarantined-orphans"
            className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sw-xs text-sw-muted"
          >
            <span>orphaned intents</span>
            <span className="text-sw-text">{info.orphanedIntents.join(", ")}</span>
          </span>
        ) : null}
        {!imported ? (
          <span className="mt-3 flex flex-wrap items-center gap-2">
            {RESOLUTIONS.map((r) => (
              <Button
                key={r.resolution}
                variant={r.variant}
                size="sm"
                disabled={busy}
                title={r.hint}
                onClick={() => unquarantineMutation.mutate(r.resolution)}
                data-testid={`run-quarantined-${r.resolution}`}
              >
                {r.label}
              </Button>
            ))}
          </span>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
