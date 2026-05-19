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

import { AUTO_WAKE_PAUSE_REASONS, type FeedEvent, type PauseReason } from "@swarm/types";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import {
  AlertOctagon,
  AlertTriangle,
  Check,
  Clock,
  Inbox,
  Pause,
  Play,
  RotateCcw,
  Server,
  ShieldAlert,
  TimerOff,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { memo, useMemo } from "react";
import { Link } from "react-router-dom";
import type { RunDetail } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { rowEnterFromTop } from "../lib/feedMotion.ts";
import { feedAtom, feedEventKey, feedLoadingAtom } from "../lib/globalFeed.ts";
import { queries } from "../lib/queries.ts";
import { shortRunId } from "../lib/runId.ts";
import { formatRelative } from "../lib/time.ts";
import { useNowSeconds } from "../lib/useNowExternal.ts";
import { SseLiveDot } from "./SseLiveDot.tsx";
import { EmptyState } from "./ui/empty-state.tsx";
import { SectionTitle } from "./ui/section-title.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { WorkflowLink } from "./WorkflowLink.tsx";

/** Activity heading composes a live-stream dot inline with the title.
 * The dot is the only signal an operator gets that the timeline below
 * might be stale — placed next to the heading rather than tucked into
 * the sidebar so it sits in the operator's primary line of sight. */
function ActivityHeading(): JSX.Element {
  return (
    <SectionTitle>
      <span className="inline-flex items-center gap-2">
        Activity
        <SseLiveDot />
      </span>
    </SectionTitle>
  );
}

interface FeedKindMeta {
  Icon: typeof Play;
  verb: string;
  /** Optional Tailwind class for the icon colour. Defaults to
   * `text-sw-muted` when absent. */
  iconClass?: string;
  /** CSS var (e.g. `var(--sw-accent-error)`) for the row's left
   * attention strip. When unset, the row uses the row's `iconClass`
   * tone via fallback — keeps icon and strip visually paired so the
   * strip never disagrees with the icon's mood. */
  borderVar?: string;
  /** Reserved for events an operator might want to act on (paused
   * runs, halts, quarantines, system-health warnings). When true the
   * row renders a left strip in `borderVar`. The Inbox section owns
   * actual CTAs. */
  attention?: boolean;
}

// Verbs are kept short on purpose — the icon already conveys mood,
// and the attention border distinguishes "paused (awaiting input)"
// from "paused (provider error)" without spelling that out in the
// gutter. Hover tooltip on the row link carries the longer context.
//
// Pause-family palette (recoverable-budget-pause.md Stage 2):
//   paused_human → orange  (workflow asks; answer the question)
//   paused      → yellow  (operator must act)
//   paused_auto → blue    (daemon timer; system on it) — applied
//                          dynamically in `metaForEvent` based on
//                          `fact.run_paused.payload.reason`.
// Halted is destructive (red) — terminal failure, not a recoverable
// pause; the strip + icon both carry the error tone so the row reads
// as "this run died" without needing the verb.
const KIND_META: Readonly<Record<string, FeedKindMeta>> = {
  "fact.run_started": { Icon: Play, verb: "started", iconClass: "text-sw-accent-thinking" },
  "fact.run_completed": { Icon: Check, verb: "completed", iconClass: "text-sw-accent-success" },
  "fact.run_paused_human": {
    Icon: Pause,
    verb: "awaiting input",
    iconClass: "text-sw-accent-pause-hitl",
    borderVar: "var(--sw-accent-pause-hitl)",
    attention: true,
  },
  "fact.run_paused": {
    Icon: AlertTriangle,
    verb: "paused",
    iconClass: "text-sw-accent-pause",
    borderVar: "var(--sw-accent-pause)",
    attention: true,
  },
  // Auto-retry chain: emitted once per scheduled retry attempt. Operators
  // see the chain in the feed without needing a separate UI surface.
  // Tracks paused_auto's tone so a chain of (paused_auto, retry, retry,
  // resumed) reads as one visually-coherent timeline.
  "fact.provider_retry_attempted": {
    Icon: Clock,
    verb: "retry queued",
    iconClass: "text-sw-accent-pause-auto",
  },
  "fact.run_resumed": { Icon: Play, verb: "resumed", iconClass: "text-sw-accent-thinking" },
  "fact.run_cancelled": { Icon: X, verb: "cancelled" },
  "fact.run_halted": {
    Icon: AlertOctagon,
    verb: "halted",
    iconClass: "text-sw-accent-error",
    borderVar: "var(--sw-accent-error)",
    attention: true,
  },
  "fact.run_quarantined": {
    Icon: ShieldAlert,
    verb: "quarantined",
    iconClass: "text-sw-accent-error",
    borderVar: "var(--sw-accent-error)",
    attention: true,
  },
  "fact.run_requeued_after_crash": { Icon: RotateCcw, verb: "requeued" },
  "fact.daemon_takeover": { Icon: Server, verb: "takeover", attention: true },
  "fact.handler_timeout_leaked": { Icon: TimerOff, verb: "timeout", attention: true },
};

const FALLBACK_META: FeedKindMeta = { Icon: Inbox, verb: "" };

/** Defense-in-depth client filter. `FEED_EVENT_KINDS` in `@swarm/types`
 *  is the authoritative server-side allowlist; this set catches anything
 *  that slips through. Currently `fact.subrun_completed` is the only
 *  entry: it is not in `FEED_EVENT_KINDS` today, but the guard protects
 *  against operator noise if it is ever re-added. */
const HIDDEN_FEED_TYPES: ReadonlySet<string> = new Set(["fact.subrun_completed"]);

/** True for events that flow through `FEED_EVENT_KINDS` (so the server
 *  ships them) but shouldn't render as a visible row. Exported for unit
 *  tests; the `GlobalFeed` body filters `rows` through this. */
export function isFeedRowHidden(event: FeedEvent): boolean {
  return HIDDEN_FEED_TYPES.has(event.type);
}

/** Resolve the row's icon + verb. For most kinds the static
 *  {@link KIND_META} is enough; `fact.run_paused` peeks at
 *  `payload.reason` to differentiate operator-resumable (yellow) from
 *  auto-wake (blue), and `fact.run_resumed` peeks at `fromStatus` so
 *  the operator can tell at a glance what kind of pause was just
 *  lifted. Exported for unit tests. */
export function metaForEvent(event: FeedEvent): FeedKindMeta {
  const base = KIND_META[event.type] ?? FALLBACK_META;
  if (event.type === "fact.run_paused") {
    const reason = (event.payload as { reason?: unknown } | null)?.reason;
    if (typeof reason === "string" && AUTO_WAKE_PAUSE_REASONS.has(reason as PauseReason)) {
      return {
        ...base,
        verb: "auto-retry",
        iconClass: "text-sw-accent-pause-auto",
        borderVar: "var(--sw-accent-pause-auto)",
      };
    }
  }
  if (event.type === "fact.run_resumed") {
    const fromStatus = (event.payload as { fromStatus?: unknown } | null)?.fromStatus;
    if (fromStatus === "paused_human") return { ...base, verb: "resumed" };
    if (fromStatus === "paused") return { ...base, verb: "retrying" };
    if (fromStatus === "paused_auto") return { ...base, verb: "retrying" };
  }
  return base;
}

export function GlobalFeed(): JSX.Element {
  const events = useAtomValue(feedAtom);
  const isLoading = useAtomValue(feedLoadingAtom);
  const reduce = useReducedMotion() ?? false;

  // Render newest-first — operators glance at the top of the list.
  // Mechanical types (e.g. `fact.run_branched`) are kept in the atom but
  // suppressed here so the operator-facing list stays signal-only.
  const rows = useMemo(() => events.filter((e) => !isFeedRowHidden(e)).reverse(), [events]);

  return (
    <section data-testid="global-feed" aria-label="Recent activity" className="flex flex-col gap-4">
      <ActivityHeading />
      {/* Three body states — initial-load skeleton (sized to match the
          populated layout so the backfill lands without reflow), empty
          state, and the live list. */}
      {isLoading && rows.length === 0 ? (
        <ul
          aria-busy="true"
          className="rounded-sw-none border border-sw-border bg-sw-surface sm:grid sm:grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] sm:gap-x-3"
        >
          {(["a", "b", "c", "d"] as const).map((k) => (
            <FeedRowSkeleton key={k} />
          ))}
        </ul>
      ) : rows.length === 0 ? (
        <EmptyState
          data-testid="global-feed-empty"
          icon={<Play className="size-6" aria-hidden />}
          title="No activity yet"
          description="Run events appear here as workflows execute."
          className="min-h-[120px]"
        />
      ) : (
        // CSS grid on the list, subgrid on each row, so the icon and
        // verb columns size to the widest content across all rows
        // without a hand-tuned width.
        // - Mobile (< sm): each row is its own 3-column grid laid out
        //   in two rows: `[icon][verb][ts] / [title spans 2][workflow]`.
        //   We can't use subgrid for the mobile layout because the
        //   cross-row alignment we want there is intra-row, not
        //   inter-row.
        // - Desktop (≥ sm): the `<ul>` is a 5-column grid and each row
        //   uses `grid-cols-subgrid`, so the icon / verb columns size
        //   to the widest content across every row.
        <ul className="rounded-sw-none border border-sw-border bg-sw-surface sm:grid sm:grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] sm:gap-x-3">
          <AnimatePresence initial={false}>
            {rows.map((event) => (
              <FeedRow key={feedEventKey(event)} event={event} reduce={reduce} />
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}

interface FeedRowProps {
  event: FeedEvent;
  reduce: boolean;
}

const FeedRow = memo(function FeedRow({ event, reduce }: FeedRowProps): JSX.Element {
  const { Icon, verb, iconClass, attention, borderVar } = metaForEvent(event);

  // Dedicated detail query per runId. TanStack dedupes concurrent
  // reads of the same id, so 30 feed rows pointing at 12 distinct
  // runs result in 12 fetches max — and each row only re-renders
  // when *its* run's data lands. Lifecycle SSE frames invalidate
  // this query for the affected run only (see useGlobalEventStream),
  // so the title fills in promptly after the auto-titler runs.
  const { data: run } = useQuery(queries.runs.detail(event.runId));

  const { initial, animate, exit, transition } = rowEnterFromTop(reduce);

  const wf = run?.workflowName ?? run?.workflow;

  // The strip color follows the row's mood: meta.borderVar when set
  // (carried by attention-class kinds — paused, halted, quarantined
  // etc.), otherwise the row's icon tone via the `--sw-accent-thinking`
  // fallback for the legacy attention rows that don't carry an
  // explicit borderVar (daemon_takeover, handler_timeout_leaked).
  const stripColor = borderVar ?? "var(--sw-accent-thinking)";

  return (
    <motion.li
      layout
      initial={initial}
      animate={animate}
      exit={exit}
      transition={transition}
      style={
        attention
          ? { willChange: reduce ? undefined : "transform", borderLeftColor: stripColor }
          : { willChange: reduce ? undefined : "transform" }
      }
      className={cn(
        // `rounded-sw-none` defeats the global `* { border-radius: 2px }`
        // rule (globals.css) — the strip has to read as a flat
        // edge-to-edge stripe, not a clipped curve, so it slots cleanly
        // into the surrounding grid.
        "group grid items-center rounded-sw-none px-3 py-2 text-sw-sm",
        // Mobile: 3-col, 2-row grid. Children placed via col-start /
        // row-start below. `gap-y-0.5` (2px) gives a tight visual
        // separation between the verb line and the title line.
        "grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2 gap-y-0.5",
        // Desktop: collapse to a single subgrid row of the parent's
        // 5-column grid. The mobile col/row placements below get
        // overridden with `sm:` modifiers.
        "sm:col-span-full sm:grid-cols-subgrid sm:gap-x-3 sm:gap-y-0",
        attention ? "border-l-2" : "border-l-2 border-transparent",
      )}
    >
      <Icon className={`col-start-1 row-start-1 size-4 self-center ${iconClass ?? "text-sw-muted"}`} aria-hidden />
      <span className="col-start-2 row-start-1 truncate text-sw-muted">{verb}</span>
      {/* Time: top-right on mobile (col 3 row 1); col 5 row 1 on
          desktop. Explicit `sm:row-start-1` everywhere (instead of
          `row-auto`) keeps the desktop row truly single-line — the
          row-auto shorthand was unreliable next to a longhand
          `row-start-2` from the mobile variant. */}
      <FeedRowTime ts={event.ts} className="col-start-3 row-start-1 ml-auto text-right sm:col-start-5 sm:ml-0" />
      <Link
        to={`/runs/${event.runId}`}
        title={runTitleTooltip(event.runId, run)}
        className="col-span-2 col-start-1 row-start-2 min-w-0 truncate font-medium text-sw-text hover:underline sm:col-span-1 sm:col-start-3 sm:row-start-1"
      >
        {displayRunTitle(event.runId, run)}
      </Link>
      {wf ? (
        <WorkflowLink
          name={wf}
          variant="badge"
          className="col-start-3 row-start-2 max-w-[10rem] justify-self-end sm:col-start-4 sm:row-start-1 sm:justify-self-auto"
        />
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
      className={cn("shrink-0 min-w-[7rem] text-right text-sw-xs text-sw-muted tabular-nums", className)}
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
  return shortRunId(runId);
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

/** Placeholder row used during the initial feed backfill. Mirrors the
 * real `FeedRow`'s grid layout (mobile 2-row → desktop subgrid) so the
 * skeleton-to-real swap doesn't reflow the page. */
function FeedRowSkeleton(): JSX.Element {
  return (
    <li
      className={cn(
        "grid items-center rounded-sw-none px-3 py-2 text-sm",
        "grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2 gap-y-0.5",
        "sm:col-span-full sm:grid-cols-subgrid sm:gap-x-3 sm:gap-y-0",
        "border-l-2 border-transparent",
      )}
    >
      <Skeleton className="col-start-1 row-start-1 size-4" />
      <Skeleton className="col-start-2 row-start-1 h-3 w-20" />
      <Skeleton className="col-start-3 row-start-1 ml-auto h-3 w-28 sm:col-start-5 sm:ml-0" />
      <Skeleton className="col-span-2 col-start-1 row-start-2 h-3 w-48 max-w-full sm:col-span-1 sm:col-start-3 sm:row-start-1" />
      <Skeleton className="col-start-3 row-start-2 h-4 w-20 justify-self-end sm:col-start-4 sm:row-start-1 sm:justify-self-auto" />
    </li>
  );
}
