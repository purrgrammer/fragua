// GlobalFeed — Home page timeline of operator-relevant system events.
//
// Reads the `feedAtom` (driven by `useGlobalEventStream` mounted at
// the app root). Each row entrance is animated with motion's
// AnimatePresence/layout — subtle slide+fade tuned for an at-a-glance
// view operators see all day, not a marketing splash. Reduced-motion
// users see the rows snap in with no transition.
//
// Re-render discipline:
//   - The "Xs ago" tick lives in `useNowSeconds` (external store), so
//     the parent component never re-renders on the per-second tick —
//     only `<FeedRowTime>` does.
//   - `<FeedRow>` is memo'd on `(event, reduce)`. Per-row run metadata
//     (title, workflow) is fetched inside the row via
//     `useQuery(queries.runs.detail(id))`; TanStack dedupes
//     concurrent reads of the same id.

import type { FeedEvent } from "@swarm/types";
import { useQuery } from "@tanstack/react-query";
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
import { memo, useMemo } from "react";
import { Link } from "react-router-dom";
import type { RunDetail } from "../lib/api.ts";
import { feedAtom, feedEventKey } from "../lib/globalFeed.ts";
import { queries } from "../lib/queries.ts";
import { formatRelative } from "../lib/time.ts";
import { useNowSeconds } from "../lib/useNowExternal.ts";
import { Badge } from "./ui/badge.tsx";

interface FeedKindMeta {
  Icon: typeof Play;
  verb: string;
  /** Reserved for events an operator might want to act on (paused
   * runs, halts, quarantines, system-health warnings). Renders a
   * left amber accent. The Inbox section will own actual CTAs. */
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

// Animation choices per the web-animation-design skill: ease-out-cubic
// for entries (items entering the viewport), 180ms duration (under
// 250ms — fires constantly), only transform + opacity (GPU-only, no
// layout thrash). Reflow on neighbours uses ease-in-out (movement on
// screen).
const EASE_OUT_CUBIC: [number, number, number, number] = [0.215, 0.61, 0.355, 1];
const ENTER_DURATION_S = 0.18;
const LAYOUT_DURATION_S = 0.18;

export function GlobalFeed(): JSX.Element {
  const events = useAtomValue(feedAtom);
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
            <FeedRow key={feedEventKey(event)} event={event} reduce={reduce} />
          ))}
        </AnimatePresence>
      </ul>
    </section>
  );
}

interface FeedRowProps {
  event: FeedEvent;
  reduce: boolean;
}

const FeedRow = memo(function FeedRow({ event, reduce }: FeedRowProps): JSX.Element {
  const meta = KIND_META[event.type] ?? FALLBACK_META;
  const { Icon, verb, attention } = meta;

  // Dedicated detail query per runId. TanStack dedupes concurrent
  // reads of the same id, so 30 feed rows pointing at 12 distinct
  // runs result in 12 fetches max — and each row only re-renders
  // when *its* run's data lands. Lifecycle SSE frames invalidate
  // this query for the affected run only (see useGlobalEventStream),
  // so the title fills in promptly after the auto-titler runs.
  const { data: run } = useQuery(queries.runs.detail(event.runId));

  const initial = reduce ? false : { opacity: 0, y: -6, scale: 0.98 };
  const animate = { opacity: 1, y: 0, scale: 1 };
  const exit = reduce ? undefined : { opacity: 0 };
  const transition = reduce ? { duration: 0 } : { duration: ENTER_DURATION_S, ease: EASE_OUT_CUBIC };
  const layoutTransition = reduce ? { duration: 0 } : { duration: LAYOUT_DURATION_S, ease: "easeInOut" as const };

  const wf = run?.workflowName ?? run?.workflow;

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
        <span className="shrink-0 text-muted-foreground">{verb}</span>
        <Link
          to={`/runs/${event.runId}`}
          title={runTitleTooltip(event.runId, run)}
          className="min-w-0 flex-1 truncate font-medium text-foreground hover:underline"
        >
          {displayRunTitle(event.runId, run)}
        </Link>
        {wf ? (
          <Link to={`/workflows/${encodeURIComponent(wf)}`} className="inline-flex max-w-[10rem] shrink-0">
            <Badge variant="muted" className="max-w-full truncate hover:underline" onClick={stopPropagation}>
              {wf}
            </Badge>
          </Link>
        ) : null}
        <FeedRowTime ts={event.ts} />
      </motion.div>
    </motion.li>
  );
});

/** Time leaf — the only thing in a row that re-renders on the 1 Hz
 * tick. Subscribes to the external `useNowSeconds` store directly so
 * neither the parent `GlobalFeed` nor the memo'd `FeedRow` re-renders
 * when wall-clock advances. */
function FeedRowTime({ ts }: { ts: number }): JSX.Element {
  const now = useNowSeconds();
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums" title={new Date(ts).toISOString()}>
      {formatRelative(ts, { now: new Date(now) })}
    </span>
  );
}

/** Same priority order as RunRow's `displayTitle`, applied to a
 * partial RunDetail (the row's data may not have arrived yet, in
 * which case we fall back to the runId prefix). */
function displayRunTitle(runId: string, run: RunDetail | undefined): string {
  if (run?.title && run.title.length > 0) return run.title;
  if (run?.input && run.input.length > 0) return clampInline(run.input, 80);
  return `${runId.slice(0, 8)}…`;
}

function runTitleTooltip(runId: string, run: RunDetail | undefined): string {
  const parts: string[] = [];
  if (run?.title) parts.push(`title: ${run.title}`);
  if (run?.input) parts.push(`input: ${run.input}`);
  const wf = run?.workflowName ?? run?.workflow;
  if (wf) parts.push(`workflow: ${wf}`);
  parts.push(`runId: ${runId}`);
  return parts.join("\n");
}

function clampInline(s: string, cap: number): string {
  const singleLine = s.replace(/\s+/g, " ").trim();
  return singleLine.length > cap ? `${singleLine.slice(0, cap - 1)}…` : singleLine;
}

/** Stop the workflow badge link from triggering the outer run-link
 * navigation when both happen to nest inside the same flex row. The
 * badge is its own `<Link>`, so the surrounding `<Link>` should not
 * intercept its click. */
function stopPropagation(e: React.MouseEvent): void {
  e.stopPropagation();
}
