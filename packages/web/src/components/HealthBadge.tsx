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
  const label = status === "loading" ? "connecting…" : status === "connected" ? "connected" : "error";
  const tone =
    status === "connected"
      ? "bg-emerald-100 text-emerald-800 border-emerald-300"
      : status === "error"
        ? "bg-rose-100 text-rose-800 border-rose-300"
        : "bg-slate-100 text-slate-700 border-slate-300";

  return (
    <span
      aria-live="polite"
      data-testid="health-badge"
      data-status={status}
      title={error ?? undefined}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${tone}`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-2 w-2 rounded-full ${
          status === "connected" ? "bg-emerald-500" : status === "error" ? "bg-rose-500" : "bg-slate-400"
        }`}
      />
      {label}
    </span>
  );
}
