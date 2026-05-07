// Inbox — runs that need operator attention.
//
// "Attention" is anything in `paused_hitl` (awaiting input on a
// wait.human gate), `paused` (operator-resumable: provider error,
// payment required, budget hit, or operator pause), or `quarantined`
// (sweep marked the run unreachable). `halted` is terminal,
// `requeued_after_crash` self-heals; both belong in Feed only.
//
// Sort: oldest-first. The metaphor is an inbox — we want neglect to
// surface to the top, not recency.
//
// Usage:
//   - <Inbox limit={5} viewAllHref="/inbox" />  on Home (capped + link)
//   - <Inbox />                                 on /inbox (uncapped)
//
// The list reads a server-filtered `queries.runs.list({ status: [...] })`
// — only paused / quarantined runs cross the wire. SSE invalidation
// prefix-matches `["runs", "list"]` so this and the unfiltered/Running
// lists all refetch on one lifecycle event.

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Pause, ShieldAlert, ShieldCheck } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Link } from "react-router-dom";
import type { RunSummary } from "../lib/api.ts";
import { rowEnterFromBottom } from "../lib/feedMotion.ts";
import { queries } from "../lib/queries.ts";
import { displayTitle, displayTooltip } from "./RunRow.tsx";
import { Badge } from "./ui/badge.tsx";
import { EmptyState } from "./ui/empty-state.tsx";
import { SectionTitle } from "./ui/section-title.tsx";
import { Skeleton } from "./ui/skeleton.tsx";

/** Raw lifecycle statuses an operator can act on. Module-scope so the
 * queryKey reference stays stable across renders. */
const ATTENTION_STATUSES: ReadonlyArray<NonNullable<RunSummary["runStatus"]>> = [
  "paused_hitl",
  "paused",
  "quarantined",
];

interface ReasonMeta {
  Icon: typeof Pause;
  label: string;
  /** Swarm state-accent class for the leading icon. The matching attention
   * border on the row uses the same accent via the `--sw-accent-*` vars. */
  iconClass: string;
  borderVar: string;
}

const REASON_META: Record<NonNullable<RunSummary["runStatus"]>, ReasonMeta | undefined> = {
  paused_hitl: {
    Icon: Pause,
    label: "awaiting input",
    iconClass: "text-sw-accent-human",
    borderVar: "var(--sw-accent-human)",
  },
  paused: {
    Icon: AlertTriangle,
    label: "needs operator",
    iconClass: "text-sw-accent-warn",
    borderVar: "var(--sw-accent-warn)",
  },
  quarantined: {
    Icon: ShieldAlert,
    label: "quarantined",
    iconClass: "text-sw-accent-error",
    borderVar: "var(--sw-accent-error)",
  },
  // Non-attention statuses — the filter never reaches these, but we
  // exhaustively type the map so a new RunStatus literal forces a
  // compile-time decision here. paused_auto is auto-resuming on a
  // timer (no operator action needed); the operator only sees it in
  // the inbox if the auto-retry chain exhausts and transitions to
  // halted/paused.
  queued: undefined,
  running: undefined,
  completed: undefined,
  cancelled: undefined,
  halted: undefined,
  paused_auto: undefined,
};

export interface InboxProps {
  /** Cap rows shown. Omitted = unbounded. */
  limit?: number;
  /** When set, render a "View all →" link at the section header. */
  viewAllHref?: string;
}

export function Inbox({ limit, viewAllHref }: InboxProps): JSX.Element {
  // Ask for `limit + 1` so the extra row signals overflow without a
  // separate count query. Server enforces filter/order/limit.
  const { data, isPending } = useQuery(
    queries.runs.list({
      status: ATTENTION_STATUSES,
      order: "oldest",
      ...(limit !== undefined ? { limit: limit + 1 } : {}),
    }),
  );
  const rows = data ?? [];
  const hasOverflow = limit !== undefined && rows.length > limit;
  const attention = hasOverflow ? rows.slice(0, limit) : rows;
  const showViewAll = viewAllHref !== undefined && hasOverflow;
  const reduce = useReducedMotion() ?? false;

  return (
    <section data-testid="inbox" className="flex flex-col gap-4">
      <SectionTitle
        action={
          showViewAll && viewAllHref ? (
            <Link to={viewAllHref} className="text-sw-muted hover:text-sw-text">
              View all →
            </Link>
          ) : null
        }
      >
        Inbox
      </SectionTitle>

      {isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : attention.length === 0 ? (
        <EmptyState
          data-testid="inbox-empty"
          icon={<ShieldCheck className="size-6 text-sw-accent-success" aria-hidden />}
          title="All clear"
          description="No runs need attention."
          className="min-h-[120px]"
        />
      ) : (
        <ul className="flex flex-col gap-2">
          <AnimatePresence initial={false}>
            {attention.map((row) => (
              <InboxRow key={row.runId} row={row} reduce={reduce} />
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}

function InboxRow({ row, reduce }: { row: RunSummary; reduce: boolean }): JSX.Element | null {
  const meta = row.runStatus ? REASON_META[row.runStatus] : undefined;
  if (!meta) return null;
  const { Icon, label, iconClass, borderVar } = meta;
  const wf = row.workflowName ?? row.workflow;
  const { initial, animate, exit, transition } = rowEnterFromBottom(reduce);
  return (
    <motion.li
      layout
      initial={initial}
      animate={animate}
      exit={exit}
      transition={transition}
      style={{ willChange: reduce ? undefined : "transform" }}
    >
      <Link
        to={`/runs/${row.runId}`}
        title={displayTooltip(row)}
        data-testid={`inbox-run-${row.runId}`}
        data-reason={row.runStatus}
        style={{ borderLeftColor: borderVar }}
        className="flex w-full min-w-0 items-center gap-3 rounded-sw-card border border-sw-border border-l-2 bg-sw-surface px-3 py-2 text-sw-sm hover:[&_.inbox-row-title]:underline"
      >
        <Icon className={`size-4 shrink-0 ${iconClass}`} aria-hidden />
        <span className="inbox-row-title flex-1 min-w-0 truncate font-medium text-sw-text">{displayTitle(row)}</span>
        {wf ? (
          <Badge variant="muted" className="max-w-[12rem] shrink-0 truncate">
            {wf}
          </Badge>
        ) : null}
        <span className="shrink-0 text-sw-xs text-sw-muted tabular-nums">{label}</span>
      </Link>
    </motion.li>
  );
}
