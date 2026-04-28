// Inbox — runs that need operator attention.
//
// "Attention" is anything in `paused_hitl` (awaiting human input),
// `paused_provider_error` (provider failed mid-run, retry/skip needed),
// or `quarantined` (sweep marked the run unreachable). `halted` is
// terminal, `requeued_after_crash` self-heals; both belong in Feed only.
//
// Sort: oldest-first. The metaphor is an inbox — we want neglect to
// surface to the top, not recency.
//
// Usage:
//   - <Inbox limit={5} viewAllHref="/inbox" />  on Home (capped + link)
//   - <Inbox />                                 on /inbox (uncapped)
//
// The list reads `queries.runs.list()` — the same query Home, RunsList,
// and the StatsTiles use, so SSE-driven invalidation keeps it fresh
// without a separate fetch path.

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Pause, ShieldAlert, ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { RunSummary } from "../lib/api.ts";
import { queries } from "../lib/queries.ts";
import { displayTitle, displayTooltip } from "./RunRow.tsx";
import { Badge } from "./ui/badge.tsx";
import { Skeleton } from "./ui/skeleton.tsx";

/** The set of raw lifecycle statuses an operator can act on. */
const ATTENTION_STATUSES = new Set<NonNullable<RunSummary["runStatus"]>>([
  "paused_hitl",
  "paused_provider_error",
  "quarantined",
]);

interface ReasonMeta {
  Icon: typeof Pause;
  label: string;
  /** Tailwind classes for the leading icon — same amber accent the
   * Feed uses for attention-worthy events, so the visual language is
   * consistent across sections. */
  iconClass: string;
}

const REASON_META: Record<NonNullable<RunSummary["runStatus"]>, ReasonMeta | undefined> = {
  paused_hitl: { Icon: Pause, label: "awaiting input", iconClass: "text-amber-600" },
  paused_provider_error: { Icon: AlertTriangle, label: "provider error", iconClass: "text-rose-600" },
  quarantined: { Icon: ShieldAlert, label: "quarantined", iconClass: "text-rose-600" },
  // Non-attention statuses — the filter never reaches these, but we
  // exhaustively type the map so a new RunStatus literal forces a
  // compile-time decision here.
  queued: undefined,
  running: undefined,
  completed: undefined,
  cancelled: undefined,
  halted: undefined,
};

export interface InboxProps {
  /** Cap rows shown. Omitted = unbounded. */
  limit?: number;
  /** When set, render a "View all →" link at the section header. */
  viewAllHref?: string;
}

export function Inbox({ limit, viewAllHref }: InboxProps): JSX.Element {
  const { data, isPending } = useQuery(queries.runs.list());
  const rows = data ?? [];

  const attention = useMemo(() => {
    const filtered = rows.filter((r) => r.runStatus !== undefined && ATTENTION_STATUSES.has(r.runStatus));
    // Oldest first: a run that's been waiting longest deserves the
    // most prominent slot.
    filtered.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    return limit !== undefined ? filtered.slice(0, limit) : filtered;
  }, [rows, limit]);

  // The "view all" link only makes sense when (a) we're capping and
  // (b) there's actually an overflow. Otherwise it's a dead link.
  const totalAttention = useMemo(
    () => rows.reduce((n, r) => (r.runStatus && ATTENTION_STATUSES.has(r.runStatus) ? n + 1 : n), 0),
    [rows],
  );
  const showViewAll = viewAllHref !== undefined && limit !== undefined && totalAttention > limit;

  return (
    <section data-testid="inbox" className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h2 className="font-heading text-base font-semibold">Inbox</h2>
        {showViewAll && viewAllHref ? (
          <Link to={viewAllHref} className="text-xs text-muted-foreground hover:text-foreground">
            View all →
          </Link>
        ) : null}
      </div>

      {isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : attention.length === 0 ? (
        <InboxEmptyState />
      ) : (
        <ul className="flex flex-col gap-2">
          {attention.map((row) => (
            <InboxRow key={row.runId} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

function InboxRow({ row }: { row: RunSummary }): JSX.Element {
  const meta = row.runStatus ? REASON_META[row.runStatus] : undefined;
  if (!meta) return <></>;
  const { Icon, label, iconClass } = meta;
  const wf = row.workflowName ?? row.workflow;
  return (
    <li>
      <Link
        to={`/runs/${row.runId}`}
        title={displayTooltip(row)}
        data-testid={`inbox-run-${row.runId}`}
        data-reason={row.runStatus}
        className="flex w-full min-w-0 items-center gap-3 rounded-md border border-border/60 border-l-2 border-l-amber-500/70 bg-card px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
      >
        <Icon className={`size-4 shrink-0 ${iconClass}`} aria-hidden />
        <span className="flex-1 min-w-0 truncate font-medium">{displayTitle(row)}</span>
        {wf ? (
          <Badge variant="muted" className="max-w-[12rem] shrink-0 truncate">
            {wf}
          </Badge>
        ) : null}
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{label}</span>
      </Link>
    </li>
  );
}

/** Calm "all clear" state — when nothing needs attention, the Inbox
 * stays present (vs hiding) to reassure the operator that the system
 * is healthy. Lower-key visual weight than the populated rows. */
function InboxEmptyState(): JSX.Element {
  return (
    <div
      data-testid="inbox-empty"
      className="flex items-center gap-3 rounded-md border border-dashed border-border/60 px-3 py-3 text-sm text-muted-foreground"
    >
      <ShieldCheck className="size-4 shrink-0 text-emerald-600" aria-hidden />
      <span>All clear — no runs need attention.</span>
    </div>
  );
}
