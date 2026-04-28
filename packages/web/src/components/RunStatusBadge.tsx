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
      ? "bg-sw-accent-success/10 text-sw-accent-success border-sw-accent-success/30"
      : status === "fail"
        ? "bg-sw-accent-error/10 text-sw-accent-error border-sw-accent-error/30"
        : status === "running"
          ? "bg-sw-accent-thinking/10 text-sw-accent-thinking border-sw-accent-thinking/30"
          : status === "queued"
            ? "bg-sw-accent-idle/10 text-sw-accent-idle border-sw-accent-idle/30"
            : status === "paused"
              ? "bg-sw-accent-idle/10 text-sw-accent-idle border-sw-accent-idle/30"
              : status === "canceled"
                ? "bg-sw-accent-idle/10 text-sw-accent-idle border-sw-accent-idle/30"
                : "bg-sw-accent-idle/10 text-sw-accent-idle border-sw-accent-idle/30";
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
