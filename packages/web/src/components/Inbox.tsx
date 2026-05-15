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

// Pause-family palette (recoverable-budget-pause.md Stage 2):
//   paused_hitl → orange  (workflow asks; answer the question)
//   paused      → yellow  (operator must act)
// quarantined stays destructive (red): it's a code-contract failure,
// not a recoverable pause.
const REASON_META: Record<NonNullable<RunSummary["runStatus"]>, ReasonMeta | undefined> = {
  paused_hitl: {
    Icon: Pause,
    label: "awaiting input",
    iconClass: "text-sw-accent-pause-hitl",
    borderVar: "var(--sw-accent-pause-hitl)",
  },
  paused: {
    Icon: AlertTriangle,
    label: "needs operator",
    iconClass: "text-sw-accent-pause",
    borderVar: "var(--sw-accent-pause)",
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
  running_children: undefined,
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
  //
  // `includeChildAttention: true` widens the filter so a parent in
  // `running_children` whose branch paused on budget / HITL also
  // surfaces — sub-runs themselves stay hidden (server enforces
  // topLevelOnly). See `docs/proposals/parallel.md` UI plan §P2/§P5.
  const { data, isPending } = useQuery(
    queries.runs.list({
      status: ATTENTION_STATUSES,
      order: "oldest",
      includeChildAttention: true,
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
  // Pick the most-actionable surface state, preferring sub-run
  // attention when only the children need help. Order matches the
  // operator's "what should I look at first" priority:
  //   1. parent itself in an attention state — pre-existing behavior
  //   2. parent in running_children with a paused/hitl/quarantined child
  //   3. neither — skip (filter widened with includeChildAttention=true
  //      can return parents whose only child is the running one;
  //      shouldn't render here).
  const selfMeta = row.runStatus ? REASON_META[row.runStatus] : undefined;
  const childReason = selfMeta == null ? digestReason(row) : null;
  const meta = selfMeta ?? childReason?.meta;
  if (!meta) return null;
  const { Icon, label, iconClass, borderVar } = meta;
  const wf = row.workflowName ?? row.workflow;
  const { initial, animate, exit, transition } = rowEnterFromBottom(reduce);
  // Reason text: parent's own reason wins; otherwise cite the branch
  // (e.g. "lens_correctness: awaiting input" when a child is HITL).
  const reasonText = selfMeta != null ? label : `${childReason?.branchHint ?? "branch"}: ${label}`;
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
        data-reason={selfMeta != null ? row.runStatus : `child:${childReason?.status ?? ""}`}
        style={{ borderLeftColor: borderVar }}
        className="flex w-full min-w-0 items-center gap-3 rounded-sw-none border border-sw-border border-l-2 bg-sw-surface px-3 py-2 text-sw-sm hover:[&_.inbox-row-title]:underline"
      >
        <Icon className={`size-4 shrink-0 ${iconClass}`} aria-hidden />
        <span className="inbox-row-title flex-1 min-w-0 truncate font-medium text-sw-text">{displayTitle(row)}</span>
        {wf ? (
          <Badge variant="muted" className="max-w-[12rem] shrink-0 truncate">
            {wf}
          </Badge>
        ) : null}
        <span className="shrink-0 text-sw-xs text-sw-muted tabular-nums">{reasonText}</span>
      </Link>
    </motion.li>
  );
}

/** When the parent itself isn't paused but one of its children is,
 *  surface that as the row's reason. Picks the most-actionable child
 *  status (HITL > paused > quarantined) and uses the parent's
 *  childStatusDigest counts as the only signal — full per-branch
 *  paused-reason resolution lives in the parent's run-detail page. */
function digestReason(
  row: RunSummary,
): { meta: ReasonMeta; status: NonNullable<RunSummary["runStatus"]>; branchHint: string } | null {
  const d = row.childStatusDigest;
  if (d == null) return null;
  if (d.pausedHitl > 0) {
    return { meta: REASON_META.paused_hitl!, status: "paused_hitl", branchHint: branchHint(d.pausedHitl, "branch") };
  }
  if (d.paused > 0) {
    return { meta: REASON_META.paused!, status: "paused", branchHint: branchHint(d.paused, "branch") };
  }
  if (d.quarantined > 0) {
    return {
      meta: REASON_META.quarantined!,
      status: "quarantined",
      branchHint: branchHint(d.quarantined, "branch"),
    };
  }
  return null;
}

function branchHint(n: number, kind: string): string {
  return n === 1 ? kind : `${n} ${kind}es`;
}
