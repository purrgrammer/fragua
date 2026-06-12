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
};

export function RunHaltedNotice({ haltReason, haltDetail }: RunHaltedNoticeProps): JSX.Element {
  const label = haltReason !== undefined ? REASON_LABELS[haltReason] : undefined;
  return (
    <Alert variant="destructive" data-testid="run-halted-notice" data-halt-reason={haltReason}>
      <AlertCircle />
      <AlertTitle>{label !== undefined ? `Run halted — ${label.toLowerCase()}` : "Run halted"}</AlertTitle>
      <AlertDescription>
        <span data-testid="run-halted-message">
          {haltDetail ?? "The run ended in a terminal failure. The event log has the full trail."}
        </span>
      </AlertDescription>
    </Alert>
  );
}
