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
//   paused_hitl (orange)         — workflow asks; answer the question
//
// Callers without the raw status (or with paused-family runStatus
// missing) fall through to the operator-attention default (`paused`)
// since that's the most likely needs-attention state.

import type { ChildStatusDigest, RunDetail, RunSummary } from "../lib/api.ts";
import { statusLabel } from "../lib/format.ts";

export interface RunStatusBadgeProps {
  status: RunSummary["status"];
  /** Raw lifecycle status from the store. Lets the badge differentiate
   * paused / paused_auto / paused_hitl; ignored for non-paused values.
   * Optional so existing call sites don't have to thread it through. */
  runStatus?: RunDetail["runStatus"];
  /** Child status digest. When the parent has paused / paused_hitl /
   *  quarantined children, the badge escalates to the paused-class
   *  tint and label even if the parent's own status is
   *  running_children — the operator's surface is "needs attention". */
  childStatusDigest?: ChildStatusDigest;
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
    case "paused_hitl":
      return "bg-sw-accent-pause-hitl/10 text-sw-accent-pause-hitl border-sw-accent-pause-hitl/30";
    default:
      return "bg-sw-accent-pause/10 text-sw-accent-pause border-sw-accent-pause/30";
  }
}

export function RunStatusBadge({
  status,
  runStatus,
  childStatusDigest,
  "data-testid": testId,
  className,
}: RunStatusBadgeProps): JSX.Element {
  // Escalate to "needs attention" when a child branch is awaiting
  // operator action. The parent is the operator-facing unit; if any
  // branch is paused / HITL / quarantined, the badge reflects that
  // even when the parent's own runStatus is running_children.
  const childAttention =
    (childStatusDigest?.pausedHitl ?? 0) > 0 ||
    (childStatusDigest?.paused ?? 0) > 0 ||
    (childStatusDigest?.quarantined ?? 0) > 0;
  const effectiveRunStatus =
    childAttention && (runStatus === "running_children" || runStatus === "running")
      ? ((childStatusDigest?.pausedHitl ?? 0) > 0 ? "paused_hitl" : "paused")
      : runStatus;
  const effectiveStatus = childAttention && (status === "running" || status === "queued") ? "paused" : status;
  const tone =
    effectiveStatus === "success"
      ? "bg-sw-accent-success/10 text-sw-accent-success border-sw-accent-success/30"
      : effectiveStatus === "fail"
        ? "bg-sw-accent-error/10 text-sw-accent-error border-sw-accent-error/30"
        : effectiveStatus === "running"
          ? "bg-sw-accent-thinking/10 text-sw-accent-thinking border-sw-accent-thinking/30"
          : effectiveStatus === "queued"
            ? "bg-sw-accent-idle/10 text-sw-accent-idle border-sw-accent-idle/30"
            : effectiveStatus === "paused"
              ? pausedTone(effectiveRunStatus)
              : "bg-sw-accent-idle/10 text-sw-accent-idle border-sw-accent-idle/30";
  // Running badges pulse to signal "alive" — same `.sw-pulse` treatment
  // the Shimmer component uses (opacity 1.0 → 0.55 → 1.0, with a
  // prefers-reduced-motion fallback in globals.css).
  const pulse = effectiveStatus === "running" ? "sw-pulse" : "";
  return (
    <span
      data-testid={testId ?? `status-${effectiveStatus}`}
      data-status={effectiveStatus}
      data-run-status={effectiveRunStatus}
      data-child-attention={childAttention ? "true" : undefined}
      className={`inline-block shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tone} ${pulse}${className ? ` ${className}` : ""}`.trim()}
    >
      {statusLabel(effectiveStatus)}
    </span>
  );
}
