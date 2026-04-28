// GlobalFeed — Home page timeline of operator-relevant system events.
//
// Reads the `feedAtom` (driven by `useGlobalEventStream` mounted at
// the app root). Each row entrance is animated with motion's
// AnimatePresence/layout — subtle slide+fade tuned for an at-a-glance
// view operators see all day, not a marketing splash. Reduced-motion
// users see the rows snap in with no transition.

import type { FeedEvent } from "@swarm/types";
import { useAtomValue } from "jotai";
import {
  AlertOctagon,
  AlertTriangle,
  ArrowUpDown,
  Check,
  Inbox,
  MessageSquare,
  Pause,
  Play,
  RotateCcw,
  Server,
  ShieldAlert,
  ShieldCheck,
  TimerOff,
  User as UserIcon,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { feedAtom, feedEventKey } from "../lib/globalFeed.ts";
import { formatRelative } from "../lib/time.ts";
import { useNow } from "../lib/useNow.ts";

/** Display metadata for each event kind: icon, human verb, and an
 * `attention` flag that adds a left accent border to the row. The flag
 * is reserved for events an operator might want to act on (paused
 * runs, halts, quarantines, system-health warnings). The dedicated
 * Inbox section will own the actual CTAs once it lands. */
interface FeedKindMeta {
  Icon: typeof Play;
  verb: string;
  attention?: boolean;
}

const KIND_META: Readonly<Record<string, FeedKindMeta>> = {
  "intent.run_enqueued": { Icon: Inbox, verb: "queued" },
  "fact.run_started": { Icon: Play, verb: "started" },
  "fact.run_completed": { Icon: Check, verb: "completed" },
  "fact.run_paused_hitl": { Icon: Pause, verb: "paused (awaiting input)", attention: true },
  "fact.run_paused_provider_error": { Icon: AlertTriangle, verb: "paused (provider error)", attention: true },
  "fact.run_resumed": { Icon: Play, verb: "resumed" },
  "fact.run_cancelled": { Icon: X, verb: "cancelled" },
  "fact.run_halted": { Icon: AlertOctagon, verb: "halted", attention: true },
  "fact.run_quarantined": { Icon: ShieldAlert, verb: "quarantined", attention: true },
  "fact.run_requeued_after_crash": { Icon: RotateCcw, verb: "requeued after crash" },
  "intent.pause_requested": { Icon: Pause, verb: "pause requested" },
  "intent.cancel_requested": { Icon: X, verb: "cancel requested" },
  "intent.steering_requested": { Icon: MessageSquare, verb: "steered" },
  "intent.unquarantine": { Icon: ShieldCheck, verb: "unquarantined" },
  "intent.priority_adjusted": { Icon: ArrowUpDown, verb: "priority adjusted" },
  "intent.hitl_input": { Icon: UserIcon, verb: "human input" },
  "intent.resume": { Icon: Play, verb: "resume requested" },
  "fact.daemon_takeover": { Icon: Server, verb: "daemon takeover", attention: true },
  "fact.handler_timeout_leaked": { Icon: TimerOff, verb: "handler timeout leaked", attention: true },
};

const FALLBACK_META: FeedKindMeta = { Icon: Inbox, verb: "" };

// Animation choices, per the web-animation-design skill:
//   - Easing: ease-out-cubic — items entering the viewport.
//   - Duration: 180ms — short, fires constantly, never showy.
//   - Initial: translateY(-6px) + scale(0.98), not from scale(0).
//   - Properties: only transform + opacity (GPU-only, no layout thrash).
//   - Reflow on existing rows: shorter ease-in-out (movement on screen).
const EASE_OUT_CUBIC: [number, number, number, number] = [0.215, 0.61, 0.355, 1];
const ENTER_DURATION_S = 0.18;
const EXIT_DURATION_S = 0.12;
const LAYOUT_DURATION_S = 0.18;

export function GlobalFeed(): JSX.Element {
  const events = useAtomValue(feedAtom);
  // Tick once a second so "Xs ago" rows update without re-fetching.
  // Disabled when the feed is empty so we don't burn timers on quiet
  // pages.
  const now = useNow(1000, events.length > 0);
  const reduce = useReducedMotion() ?? false;

  // Render newest-first — operators glance at the top of the list.
  const rows = useMemo(() => events.slice().reverse(), [events]);

  if (rows.length === 0) {
    return (
      <section data-testid="global-feed" aria-label="Recent activity">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Activity</h2>
        <div className="rounded border border-dashed border-border/60 px-4 py-6 text-center text-xs text-muted-foreground">
          No recent events.
        </div>
      </section>
    );
  }

  return (
    <section data-testid="global-feed" aria-label="Recent activity">
      <h2 className="mb-2 text-sm font-medium text-muted-foreground">Activity</h2>
      <ul className="flex flex-col gap-px overflow-hidden rounded border border-border/60 bg-card">
        <AnimatePresence initial={false}>
          {rows.map((event) => (
            <FeedRow key={feedEventKey(event)} event={event} now={now} reduce={reduce} />
          ))}
        </AnimatePresence>
      </ul>
    </section>
  );
}

interface FeedRowProps {
  event: FeedEvent;
  now: number;
  reduce: boolean;
}

function FeedRow({ event, now, reduce }: FeedRowProps): JSX.Element {
  const meta = KIND_META[event.type] ?? FALLBACK_META;
  const { Icon, verb, attention } = meta;

  const initial = reduce ? false : { opacity: 0, y: -6, scale: 0.98 };
  const animate = { opacity: 1, y: 0, scale: 1 };
  const exit = reduce ? undefined : { opacity: 0 };
  const transition = reduce
    ? { duration: 0 }
    : { duration: ENTER_DURATION_S, ease: EASE_OUT_CUBIC };
  const layoutTransition = reduce
    ? { duration: 0 }
    : { duration: LAYOUT_DURATION_S, ease: "easeInOut" as const };

  // Suppress the time-ago string until `now` is initialized; otherwise
  // SSR mismatch warnings on hydration.
  const ago = now > 0 ? formatRelative(event.ts, { now: new Date(now) }) : "";

  return (
    <motion.li
      layout
      initial={initial}
      animate={animate}
      exit={exit}
      transition={transition}
      style={{ willChange: reduce ? undefined : "transform" }}
      className={[
        "group flex items-center gap-3 px-3 py-2 text-sm",
        attention ? "border-l-2 border-amber-500/70 bg-amber-500/5" : "border-l-2 border-transparent",
      ].join(" ")}
    >
      <motion.div layout="position" transition={layoutTransition} className="contents">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <Link
          to={`/runs/${event.runId}`}
          className="min-w-0 flex-1 truncate text-foreground transition-colors hover:text-primary"
        >
          <span className="font-medium">{verb}</span>
          <span className="ml-2 font-mono text-xs text-muted-foreground">{event.runId.slice(0, 8)}</span>
        </Link>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums" title={new Date(event.ts).toISOString()}>
          {ago}
        </span>
      </motion.div>
    </motion.li>
  );
}
