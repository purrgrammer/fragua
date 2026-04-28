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
import { cn } from "../lib/cn.ts";
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

// Verbs are kept short on purpose — the icon already conveys mood,
// and the attention border distinguishes "paused (awaiting input)"
// from "paused (provider error)" without spelling that out in the
// gutter. Hover tooltip on the row link carries the longer context.
const KIND_META: Readonly<Record<string, FeedKindMeta>> = {
  "intent.run_enqueued": { Icon: Inbox, verb: "queued" },
  "fact.run_started": { Icon: Play, verb: "started" },
  "fact.run_completed": { Icon: Check, verb: "completed" },
  "fact.run_paused_hitl": { Icon: Pause, verb: "awaiting input", attention: true },
  "fact.run_paused_provider_error": { Icon: AlertTriangle, verb: "provider error", attention: true },
  "fact.run_resumed": { Icon: Play, verb: "resumed" },
  "fact.run_cancelled": { Icon: X, verb: "cancelled" },
  "fact.run_halted": { Icon: AlertOctagon, verb: "halted", attention: true },
  "fact.run_quarantined": { Icon: ShieldAlert, verb: "quarantined", attention: true },
  "fact.run_requeued_after_crash": { Icon: RotateCcw, verb: "requeued" },
  "intent.pause_requested": { Icon: Pause, verb: "pausing" },
  "intent.cancel_requested": { Icon: X, verb: "cancelling" },
  "intent.steering_requested": { Icon: MessageSquare, verb: "steered" },
  "intent.unquarantine": { Icon: ShieldCheck, verb: "unquarantined" },
  "intent.priority_adjusted": { Icon: ArrowUpDown, verb: "reprioritized" },
  "intent.hitl_input": { Icon: UserIcon, verb: "input" },
  "intent.resume": { Icon: Play, verb: "resuming" },
  "fact.daemon_takeover": { Icon: Server, verb: "takeover", attention: true },
  "fact.handler_timeout_leaked": { Icon: TimerOff, verb: "timeout", attention: true },
};

const FALLBACK_META: FeedKindMeta = { Icon: Inbox, verb: "" };

// Animation choices per the web-animation-design skill: ease-out-cubic
// for entries (items entering the viewport), 180ms duration (under
// 250ms — fires constantly), only transform + opacity (GPU-only, no
// layout thrash). Reflow on neighbours uses ease-in-out (movement on
// screen).
const EASE_OUT_CUBIC: [number, number, number, number] = [0.215, 0.61, 0.355, 1];
const ENTER_DURATION_S = 0.18;

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
      {/* CSS grid on the list, subgrid on each row, so the icon and
          verb columns size to the widest content across all rows
          without a hand-tuned width.
          - Mobile (< sm): each row is its own 3-column grid laid out
            in two rows: `[icon][verb][ts] / [title spans 2][workflow]`.
            We can't use subgrid for the mobile layout because the
            cross-row alignment we want there is intra-row, not
            inter-row.
          - Desktop (≥ sm): the `<ul>` is a 5-column grid and each row
            uses `grid-cols-subgrid`, so the icon / verb columns size
            to the widest content across every row. */}
      <ul className="overflow-hidden rounded border border-border/60 bg-card sm:grid sm:grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] sm:gap-x-3">
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

  const wf = run?.workflowName ?? run?.workflow;

  return (
    <motion.li
      layout
      initial={initial}
      animate={animate}
      exit={exit}
      transition={transition}
      style={{ willChange: reduce ? undefined : "transform" }}
      className={cn(
        "group grid items-center px-3 py-2 text-sm",
        // Mobile: 3-col, 2-row grid. Children placed via col-start /
        // row-start below. `gap-y-0.5` (2px) gives a tight visual
        // separation between the verb line and the title line.
        "grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2 gap-y-0.5",
        // Desktop: collapse to a single subgrid row of the parent's
        // 5-column grid. The mobile col/row placements below get
        // overridden with `sm:` modifiers.
        "sm:col-span-full sm:grid-cols-subgrid sm:gap-x-3 sm:gap-y-0",
        attention ? "border-l-2 border-amber-500/70 bg-amber-500/5" : "border-l-2 border-transparent",
      )}
    >
      <Icon
        className="col-start-1 row-start-1 size-4 self-center text-muted-foreground sm:row-auto"
        aria-hidden
      />
      <span className="col-start-2 row-start-1 truncate text-muted-foreground sm:col-start-2 sm:row-auto">{verb}</span>
      {/* Time: top-right on mobile (col 3 row 1); pushed to last column
          (col 5) on desktop via order, since DOM order would otherwise
          place it before title. */}
      <FeedRowTime
        ts={event.ts}
        className="col-start-3 row-start-1 ml-auto text-right sm:row-auto sm:ml-0 sm:order-last"
      />
      <Link
        to={`/runs/${event.runId}`}
        title={runTitleTooltip(event.runId, run)}
        className="col-span-2 col-start-1 row-start-2 min-w-0 truncate font-medium text-foreground hover:underline sm:col-span-1 sm:col-start-3 sm:row-auto"
      >
        {displayRunTitle(event.runId, run)}
      </Link>
      {wf ? (
        <Link
          to={`/workflows/${encodeURIComponent(wf)}`}
          className="col-start-3 row-start-2 inline-flex max-w-[10rem] justify-self-end sm:col-start-4 sm:row-auto sm:justify-self-auto"
        >
          <Badge variant="muted" className="max-w-full truncate hover:underline">
            {wf}
          </Badge>
        </Link>
      ) : (
        <span aria-hidden className="hidden sm:inline" />
      )}
    </motion.li>
  );
});

/** Time leaf — the only thing in a row that re-renders on the 1 Hz
 * tick. Subscribes to the external `useNowSeconds` store directly so
 * neither the parent `GlobalFeed` nor the memo'd `FeedRow` re-renders
 * when wall-clock advances. */
function FeedRowTime({ ts, className }: { ts: number; className?: string }): JSX.Element {
  const now = useNowSeconds();
  return (
    <span
      className={cn("shrink-0 text-xs text-muted-foreground tabular-nums", className)}
      title={new Date(ts).toISOString()}
    >
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

