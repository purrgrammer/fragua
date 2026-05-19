// Standalone run-status badge used wherever a per-run status needs a
// consistent pill treatment: RunRow, RunDetail header, etc.
//
// Visual contract: rounded-full pill, xs font, colour palette keyed on
// every run status the server emits. Unknown values fall back to
// neutral slate. Carries `data-testid` and `data-status` attributes for
// reliable test selection.
//
// Paused-family colour partition (recoverable-budget-pause.md Stage 2):
// the coarse `status` collapses three raw lifecycle states to "paused",
// so callers that want the fine-grained colour pass the raw `runStatus`
// alongside. The badge then differentiates:
//
//   paused      (yellow / amber) — operator must act
//   paused_auto (steel blue)     — daemon timer; system on it
//   paused_human (orange)         — workflow asks; answer the question
//
// Callers without the raw status (or with paused-family runStatus
// missing) fall through to the operator-attention default (`paused`)
// since that's the most likely needs-attention state.

import type { RunDetail, RunSummary } from "../lib/api.ts";
import { statusLabel } from "../lib/format.ts";

export interface RunStatusBadgeProps {
  status: RunSummary["status"];
  /** Raw lifecycle status from the store. Lets the badge differentiate
   * paused / paused_auto / paused_human; ignored for non-paused values.
   * Optional so existing call sites don't have to thread it through. */
  runStatus?: RunDetail["runStatus"];
  /** Optional override for the `data-testid` attribute.
   *  Defaults to `status-<status>` (e.g. `status-running`). */
  "data-testid"?: string;
  /** Additional CSS classes to merge onto the badge element. */
  className?: string;
}

function pausedTone(runStatus: RunDetail["runStatus"] | undefined): string {
  switch (runStatus) {
    case "paused_auto":
      return "bg-sw-accent-pause-auto/10 text-sw-accent-pause-auto border-sw-accent-pause-auto/30";
    case "paused_human":
      return "bg-sw-accent-pause-hitl/10 text-sw-accent-pause-hitl border-sw-accent-pause-hitl/30";
    default:
      return "bg-sw-accent-pause/10 text-sw-accent-pause border-sw-accent-pause/30";
  }
}

export function RunStatusBadge({
  status,
  runStatus,
  "data-testid": testId,
  className,
}: RunStatusBadgeProps): JSX.Element {
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
              ? pausedTone(runStatus)
              : "bg-sw-accent-idle/10 text-sw-accent-idle border-sw-accent-idle/30";
  // Running badges pulse to signal "alive" — same `.sw-pulse` treatment
  // the Shimmer component uses (opacity 1.0 → 0.55 → 1.0, with a
  // prefers-reduced-motion fallback in globals.css).
  const pulse = status === "running" ? "sw-pulse" : "";
  return (
    <span
      data-testid={testId ?? `status-${status}`}
      data-status={status}
      data-run-status={runStatus}
      className={`inline-block shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tone} ${pulse}${className ? ` ${className}` : ""}`.trim()}
    >
      {statusLabel(status)}
    </span>
  );
}
