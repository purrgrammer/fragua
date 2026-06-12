// CrashRequeueNotice — informational banner on the run-detail page when the
// run's log carries one or more `fact.run_requeued_after_crash` events: a
// daemon died mid-dispatch and the startup sweep requeued the run. Purely
// presentational (no actions, no mutations) — it explains why the run
// restarted instead of leaving the operator guessing.

import { RotateCcw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { RunDetail } from "@/lib/api";
import { formatDateTime } from "@/lib/time";

export interface CrashRequeueNoticeProps {
  crashRequeues: NonNullable<RunDetail["crashRequeues"]>;
}

export function CrashRequeueNotice({ crashRequeues }: CrashRequeueNoticeProps): JSX.Element | null {
  if (crashRequeues.length === 0) return null;
  return (
    <Alert data-testid="crash-requeue-notice">
      <RotateCcw />
      <AlertTitle>Requeued after daemon crash</AlertTitle>
      <AlertDescription>
        <span data-testid="crash-requeue-message">
          {crashRequeues.map((r) => (
            <span key={r.at} className="block">
              The daemon died mid-run; the startup sweep requeued this run at {formatDateTime(r.at)}
              {r.prevNode != null ? <span className="text-sw-muted"> (was at node {r.prevNode})</span> : null}.
            </span>
          ))}
        </span>
      </AlertDescription>
    </Alert>
  );
}
