// RunHaltedNotice — read-only banner rendered above the run-detail tabs
// when the run is `halted`. Unlike RunPausedNotice there is nothing to
// click: a halt is terminal, so the banner only explains what happened
// (reason + detail from the read-plane's `haltReason` / `haltDetail`
// projection of the terminal `fact.run_halted`).
//
// `REASON_LABELS` is keyed by `HaltReason` so adding a literal to
// `HALT_REASONS` in `@fragua/types` without a label here is a TypeScript
// compile error — the same exhaustiveness anchor RunPausedNotice uses
// for `PauseReason`.

import type { HaltReason } from "@fragua/types";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export interface RunHaltedNoticeProps {
  haltReason?: HaltReason;
  haltDetail?: string;
  /** Structured diagnostic context recorded on the halt fact (OCC-exhaustion).
   *  Rendered as a micro-data row below the message when present. */
  haltContext?: {
    count?: number;
    nodeId?: string;
    iteration?: number;
    lastVersion?: number;
    attemptedFactType?: string;
  };
}

const REASON_LABELS: Record<HaltReason, string> = {
  budget: "Budget exceeded",
  error: "Unrecoverable error",
  aborted_exit: "Workflow aborted",
  occ_exhausted: "Concurrency retries exhausted",
  timeout_exhausted: "Watchdog retries exhausted",
  route_not_picked: "No route picked",
  route_call_not_isolated: "Route call not isolated",
  edge_no_match: "No matching edge",
  worktree_error: "Worktree provision failed",
};

function HaltContextRow({
  haltContext,
}: {
  haltContext: NonNullable<RunHaltedNoticeProps["haltContext"]>;
}): JSX.Element {
  const fields: Array<{ label: string; value: string }> = [];
  if (haltContext.nodeId !== undefined) fields.push({ label: "node", value: haltContext.nodeId });
  if (haltContext.iteration !== undefined) fields.push({ label: "iteration", value: String(haltContext.iteration) });
  if (haltContext.count !== undefined) fields.push({ label: "conflicts", value: String(haltContext.count) });
  if (haltContext.attemptedFactType !== undefined)
    fields.push({ label: "attempted", value: haltContext.attemptedFactType });
  if (haltContext.lastVersion !== undefined) fields.push({ label: "version", value: String(haltContext.lastVersion) });
  return (
    <span data-testid="run-halted-context" className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sw-xs text-sw-muted">
      {fields.map((f) => (
        <span key={f.label} className="flex gap-1">
          <span>{f.label}</span>
          <span className="text-sw-text">{f.value}</span>
        </span>
      ))}
    </span>
  );
}

export function RunHaltedNotice({ haltReason, haltDetail, haltContext }: RunHaltedNoticeProps): JSX.Element {
  const label = haltReason !== undefined ? REASON_LABELS[haltReason] : undefined;
  const hasContext = haltContext !== undefined && Object.values(haltContext).some((v) => v !== undefined);
  return (
    <Alert variant="destructive" data-testid="run-halted-notice" data-halt-reason={haltReason}>
      <AlertCircle />
      <AlertTitle>{label !== undefined ? `Run halted — ${label.toLowerCase()}` : "Run halted"}</AlertTitle>
      <AlertDescription>
        <span data-testid="run-halted-message">
          {haltDetail ?? "The run ended in a terminal failure. The event log has the full trail."}
        </span>
        {hasContext ? <HaltContextRow haltContext={haltContext} /> : null}
      </AlertDescription>
    </Alert>
  );
}
