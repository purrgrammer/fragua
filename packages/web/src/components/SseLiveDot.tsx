// Subtle live-stream indicator. Sits next to the "Activity" section
// title — the page where stale data is most visible — and signals
// whether the SSE feed driving the timeline is actually flowing.
//
// Visual contract:
//   - `open`         emerald dot with a slow pulse (alive, breathing).
//   - `connecting`   muted slate dot, no animation (quiet, transient).
//   - `error`        amber dot, no animation (browser is auto-retrying).
//   - `closed`       rose dot, no animation (we forced a reconnect or
//                    the stream gave up; dashboard data may be stale).
//
// The pulse uses `prefers-reduced-motion` to disable itself for users
// who opt out of motion. Tooltip carries the human explanation —
// nothing else identifies the dot.

import { useAtomValue } from "jotai";
import { feedSseStatusAtom } from "../lib/globalFeed.ts";
import type { SseStatus } from "../lib/useEventSource.ts";

export function SseLiveDot(): JSX.Element {
  const status = useAtomValue(feedSseStatusAtom);
  const { dotTone, ringTone, title, pulse } = describe(status);
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      data-testid="sse-live-dot"
      data-status={status}
      className="relative inline-flex size-2 shrink-0 items-center justify-center"
    >
      {pulse ? (
        <span
          aria-hidden="true"
          className={`absolute inline-flex size-2 rounded-full opacity-60 motion-safe:animate-ping ${ringTone}`}
        />
      ) : null}
      <span aria-hidden="true" className={`relative inline-block size-1.5 rounded-full ${dotTone}`} />
    </span>
  );
}

function describe(status: SseStatus): {
  dotTone: string;
  ringTone: string;
  title: string;
  pulse: boolean;
} {
  switch (status) {
    case "open":
      return {
        dotTone: "bg-sw-accent-success",
        ringTone: "bg-sw-accent-success/60",
        title: "Live updates connected",
        pulse: true,
      };
    case "connecting":
      return {
        dotTone: "bg-sw-accent-idle",
        ringTone: "bg-sw-accent-idle/60",
        title: "Connecting to live updates…",
        pulse: false,
      };
    case "error":
      return {
        dotTone: "bg-sw-accent-warn",
        ringTone: "bg-sw-accent-warn/60",
        title: "Live updates errored — auto-retrying",
        pulse: false,
      };
    case "closed":
      return {
        dotTone: "bg-sw-accent-error",
        ringTone: "bg-sw-accent-error/60",
        title: "Live updates disconnected — reconnecting; data may be stale",
        pulse: false,
      };
  }
}
