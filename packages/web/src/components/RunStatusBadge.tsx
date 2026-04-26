// Standalone run-status badge used wherever a per-run status needs a
// consistent pill treatment: RunRow, RunDetail header, etc.
//
// Visual contract: rounded-full pill, xs font, colour palette keyed on
// every run status the server emits. Unknown values fall back to
// neutral slate. Carries `data-testid` and `data-status` attributes for
// reliable test selection.

import type { RunSummary } from "../lib/api.ts";
import { statusLabel } from "../lib/format.ts";

export interface RunStatusBadgeProps {
  status: RunSummary["status"];
  /** Optional override for the `data-testid` attribute.
   *  Defaults to `status-<status>` (e.g. `status-running`). */
  "data-testid"?: string;
  /** Additional CSS classes to merge onto the badge element. */
  className?: string;
}

export function RunStatusBadge({ status, "data-testid": testId, className }: RunStatusBadgeProps): JSX.Element {
  const tone =
    status === "success"
      ? "bg-emerald-100 text-emerald-800 border-emerald-300"
      : status === "fail"
        ? "bg-rose-100 text-rose-800 border-rose-300"
        : status === "running"
          ? "bg-violet-100 text-violet-800 border-violet-300"
          : status === "queued"
            ? "bg-sky-100 text-sky-800 border-sky-300"
            : status === "paused"
              ? "bg-yellow-100 text-yellow-800 border-yellow-300"
              : status === "canceled"
                ? "bg-amber-100 text-amber-800 border-amber-300"
                : "bg-slate-100 text-slate-700 border-slate-300";
  // Running badges pulse to signal "alive" — same `.sw-pulse` treatment
  // the Shimmer component uses (opacity 1.0 → 0.55 → 1.0, with a
  // prefers-reduced-motion fallback in globals.css).
  const pulse = status === "running" ? "sw-pulse" : "";
  return (
    <span
      data-testid={testId ?? `status-${status}`}
      data-status={status}
      className={`inline-block shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tone} ${pulse}${className ? ` ${className}` : ""}`.trim()}
    >
      {statusLabel(status)}
    </span>
  );
}
