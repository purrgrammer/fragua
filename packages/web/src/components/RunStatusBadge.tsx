// Standalone run-status badge used wherever a per-run status needs a
// consistent pill treatment: RunRow, RunDetail header, etc.
//
// Visual contract: rounded-full pill, xs font, colour palette keyed on
// the five run statuses ("success" | "fail" | "running" | "canceled" |
// anything-else → neutral). Carries `data-testid` and `data-status`
// attributes for reliable test selection.

import type { RunSummary } from "../lib/api.ts";
import { statusLabel } from "../lib/format.ts";

export interface RunStatusBadgeProps {
  status: RunSummary["status"];
  /** Optional override for the `data-testid` attribute.
   *  Defaults to `status-<status>` (e.g. `status-running`). */
  "data-testid"?: string;
}

export function RunStatusBadge({ status, "data-testid": testId }: RunStatusBadgeProps): JSX.Element {
  const tone =
    status === "success"
      ? "bg-emerald-100 text-emerald-800 border-emerald-300"
      : status === "fail"
        ? "bg-rose-100 text-rose-800 border-rose-300"
        : status === "running"
          ? "bg-violet-100 text-violet-800 border-violet-300"
          : status === "canceled"
            ? "bg-amber-100 text-amber-800 border-amber-300"
            : "bg-slate-100 text-slate-700 border-slate-300";
  return (
    <span
      data-testid={testId ?? `status-${status}`}
      data-status={status}
      className={`inline-block shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tone}`}
    >
      {statusLabel(status)}
    </span>
  );
}
