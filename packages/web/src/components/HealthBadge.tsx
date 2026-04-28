// Connection-status pill. Lifted out of the old top-bar in `App.tsx`
// when the dashboard shell moved the badge into the sidebar footer.
//
// The styling is unchanged from the original inline version — emerald
// when connected, rose on error, slate while loading — so users who
// remember the colours from earlier builds still recognise them. Same
// `data-testid="health-badge"` so existing smoke tests keep passing.

import type { HealthStatus } from "../types/health.ts";

export interface HealthBadgeProps {
  status: HealthStatus;
  error: string | null;
}

export function HealthBadge({ status, error }: HealthBadgeProps): JSX.Element {
  const label =
    status === "loading"
      ? "connecting…"
      : status === "connected"
        ? "connected"
        : status === "no-daemon"
          ? "no daemon"
          : "error";
  const tone =
    status === "connected"
      ? "bg-sw-accent-success/10 text-sw-accent-success border-sw-accent-success/30"
      : status === "error"
        ? "bg-sw-accent-error/10 text-sw-accent-error border-sw-accent-error/30"
        : status === "no-daemon"
          ? "bg-sw-accent-warn/10 text-sw-accent-warn border-sw-accent-warn/30"
          : "bg-sw-accent-idle/10 text-sw-accent-idle border-sw-accent-idle/30";
  const dotTone =
    status === "connected"
      ? "bg-sw-accent-success"
      : status === "error"
        ? "bg-sw-accent-error"
        : status === "no-daemon"
          ? "bg-sw-accent-warn"
          : "bg-sw-accent-idle";
  const title =
    error ?? (status === "no-daemon" ? "server is up, but no daemon heartbeat — job queue is offline" : undefined);

  return (
    <span
      aria-live="polite"
      data-testid="health-badge"
      data-status={status}
      title={title}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${tone}`}
    >
      <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${dotTone}`} />
      {label}
    </span>
  );
}
