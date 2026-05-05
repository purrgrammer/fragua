// Control Center — the operator's at-a-glance dashboard.
//
// Layout (top → bottom by urgency):
//   1. Stats        — system-wide health (running count, spend, tokens, cache)
//   2. Inbox        — runs that need operator attention (capped + view all)
//   3. Running      — runs currently in flight (no pagination)
//   4. Activity     — global feed of recent system events
//
// "Recent runs" intentionally moved out of here — that view lives on
// /runs. The Control Center should answer "what does the system need
// from me right now?" first, "what's executing?" second; archive
// browsing is a different mode.

import { useQuery } from "@tanstack/react-query";
import { Coins, Database, DollarSign, Play } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { GlobalFeed } from "../components/GlobalFeed.tsx";
import { Inbox } from "../components/Inbox.tsx";
import { RunRow } from "../components/RunRow.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { SectionTitle } from "../components/ui/section-title.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { StatTile } from "../components/ui/stat-tile.tsx";
import type { RunSummary } from "../lib/api.ts";
import { rowEnterFromTop } from "../lib/feedMotion.ts";
import { percentFormatOptions, tokensCompactFormatOptions, usdFormatOptions } from "../lib/format.ts";
import { queries } from "../lib/queries.ts";
import { computeStats } from "../lib/stats.ts";

/** Cap for the Home Inbox — overflow funnels to /inbox via "View all →". */
export const INBOX_HOME_LIMIT = 5;

const RUNNING_STATUSES = ["running"] as const;

export function Home(): JSX.Element {
  // Stats reads the full list (global aggregates); Inbox + Running
  // each use their own narrowed query so sections don't share a shape.
  const [stats, statsLoading] = useStats();
  const { data: runningData, isPending: runningPending } = useQuery(queries.runs.list({ status: RUNNING_STATUSES }));
  const running = runningData ?? [];

  return (
    <div className="flex flex-col gap-8">
      <StatsTiles stats={stats} loading={statsLoading} />
      <Inbox limit={INBOX_HOME_LIMIT} viewAllHref="/inbox" />
      <RunningSection running={running} loading={runningPending} />
      <GlobalFeed />
    </div>
  );
}

function useStats(): [ReturnType<typeof computeStats>, boolean] {
  const { data, isPending } = useQuery(queries.runs.list());
  const value = useMemo(() => computeStats(data ?? []), [data]);
  return [value, isPending];
}

// ── Running section (currently-executing runs only) ──────────────────
//
// No pagination, no "recent" tail — the Control Center shows what's
// in flight right now. Archive browsing lives on /runs.

interface RunningSectionProps {
  running: RunSummary[];
  loading: boolean;
}

function RunningSection({ running, loading }: RunningSectionProps): JSX.Element {
  const reduce = useReducedMotion() ?? false;
  const { initial, animate, exit, transition } = rowEnterFromTop(reduce);

  // Server returns `updated_at DESC`, which re-sorts as a run emits
  // events. Stabilise on `startedAt` (set once to the first event's ts;
  // never re-computed) so a row's slot doesn't move while it runs. ISO
  // strings sort lexicographically by date because they share the same
  // UTC format.
  const sorted = useMemo(
    () => running.slice().sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0)),
    [running],
  );

  return (
    <section data-testid="running-section" className="flex flex-col gap-4">
      <SectionTitle
        action={
          <Link to="/runs" className="text-sw-muted hover:text-sw-text">
            View all →
          </Link>
        }
      >
        Running
      </SectionTitle>

      {loading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState
          data-testid="running-empty"
          icon={<Play className="size-6" />}
          title="Nothing running"
          description="Active runs appear here while they execute."
          className="min-h-[120px]"
        />
      ) : (
        <div data-testid="running-strip" className="flex flex-col gap-2">
          <AnimatePresence initial={false}>
            {sorted.map((row) => (
              <motion.div
                key={row.runId}
                initial={initial}
                animate={animate}
                exit={exit}
                transition={transition}
                style={{ willChange: reduce ? undefined : "transform" }}
              >
                <RunRow row={row} variant="compact" />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}

// ── Stats tiles ──────────────────────────────────────────────────────

interface StatsTilesProps {
  stats: ReturnType<typeof computeStats>;
  loading: boolean;
}

function tokensTooltip(stats: ReturnType<typeof computeStats>): string {
  const fmt = new Intl.NumberFormat();
  return [
    `input  ${fmt.format(stats.totalInputTokens)}`,
    `output ${fmt.format(stats.totalOutputTokens)}`,
    `cache read ${fmt.format(stats.totalCacheReadTokens)}`,
    `cache write ${fmt.format(stats.totalCacheWriteTokens)}`,
  ].join(" · ");
}

function cacheTooltip(stats: ReturnType<typeof computeStats>): string {
  const fmt = new Intl.NumberFormat();
  return [
    `cacheRead  ${fmt.format(stats.totalCacheReadTokens)}`,
    `cacheWrite ${fmt.format(stats.totalCacheWriteTokens)}`,
  ].join(" · ");
}

function StatsTiles({ stats, loading }: StatsTilesProps): JSX.Element {
  return (
    <section data-testid="stats-tiles">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Runs"
          loading={loading}
          numericValue={stats.totalRuns}
          format={{ notation: "compact", maximumFractionDigits: 1 }}
          icon={<Play className="size-4" />}
          testId="tile-runs"
        />
        <StatTile
          label="Spend"
          loading={loading}
          numericValue={stats.totalCostUsd}
          format={usdFormatOptions(stats.totalCostUsd ?? 0)}
          icon={<DollarSign className="size-4" />}
          testId="tile-spend"
        />
        <StatTile
          label="Tokens"
          loading={loading}
          numericValue={stats.billedTokens}
          format={tokensCompactFormatOptions(stats.billedTokens ?? 0)}
          icon={<Coins className="size-4" />}
          hint={tokensTooltip(stats)}
          testId="tile-tokens"
        />
        <StatTile
          label="Cache"
          loading={loading}
          numericValue={stats.cacheHitRate}
          format={percentFormatOptions()}
          icon={<Database className="size-4" />}
          hint={cacheTooltip(stats)}
          testId="tile-cache"
        />
      </div>
    </section>
  );
}
