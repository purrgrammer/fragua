// Home dashboard — three projections of the same `GET /pipelines`
// payload (running strip, stats tiles, recent runs). The single fetch
// is intentional: every section is a derived view, so any drift
// between sections would mean the projections themselves disagree —
// which is the kind of bug operators won't catch but will frustrate
// them.
//
// Cadence: 5s polling matches the existing `PipelinesList` (P5.06).
// We do not subscribe to a global event stream — there isn't one yet —
// and a poll is fine for a single-user dev tool.
//
// Test injection: `fetcher` is optional so the test mounts the route
// without a network round-trip. Production callers always pass `api`
// and let it default to `api.listPipelines()`.

import { CheckCircle2, Coins, DollarSign, Hash, Play, Timer } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Shimmer } from "../components/ai-elements/shimmer.tsx";
import { displayTitle, displayTooltip, PipelineRow, shortenRunId } from "../components/PipelineRow.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import type { ApiClient, PipelineSummary } from "../lib/api.ts";
import { formatTokensCompact, formatUsd } from "../lib/format.ts";
import { computeStats } from "../lib/stats.ts";
import { formatDuration } from "../lib/time.ts";

/** Polling cadence — matches the cadence Pipelines list uses. */
const POLL_MS = 5_000;

/** How many recent runs to render in the bottom section. */
const RECENT_LIMIT = 10;

export interface HomeProps {
  api: ApiClient;
  /**
   * Optional override so tests can stub the fetch path without
   * mocking the full ApiClient. Returns the raw row array; the
   * route handles all derived projections.
   */
  fetcher?: () => Promise<PipelineSummary[]>;
}

type LoadState = { kind: "loading" } | { kind: "ready"; rows: PipelineSummary[] } | { kind: "error" };

export function Home({ api, fetcher }: HomeProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [now, setNow] = useState<number>(() => Date.now());
  const fetchRef = useRef(fetcher ?? (() => api.listPipelines()));

  // Refresh `fetchRef` on prop change so tests can swap `fetcher`.
  useEffect(() => {
    fetchRef.current = fetcher ?? (() => api.listPipelines());
  }, [fetcher, api]);

  // Poll loop — load on mount + every POLL_MS. Cancelled cleanly on
  // unmount so the timer doesn't outlive the component.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const rows = await fetchRef.current();
        if (!cancelled) setState({ kind: "ready", rows });
      } catch (err: unknown) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[Home] failed to load pipelines —", message);
        setState({ kind: "error" });
      }
    }
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // Tick every second so "elapsed" on the running strip stays live.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  const rows = state.kind === "ready" ? state.rows : [];
  const running = useMemo(() => rows.filter((r) => r.status === "running"), [rows]);
  const stats = useMemo(() => computeStats(rows), [rows]);

  return (
    <div className="flex flex-col gap-8">
      <RunningStrip running={running} now={now} loading={state.kind === "loading"} />
      <StatsTiles stats={stats} loading={state.kind === "loading"} />
      <RecentRuns rows={rows.slice(0, RECENT_LIMIT)} loading={state.kind === "loading"} />
    </div>
  );
}

// ── Running strip ────────────────────────────────────────────────────

interface RunningStripProps {
  running: PipelineSummary[];
  now: number;
  loading: boolean;
}

function RunningStrip({ running, now, loading }: RunningStripProps): JSX.Element {
  return (
    <section data-testid="running-strip" className="flex flex-col gap-3">
      <h2 className="font-heading text-base font-semibold">Running</h2>
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : running.length === 0 ? (
        <EmptyState
          data-testid="running-empty"
          icon={<Play className="size-6" />}
          title="No runs in progress"
          description="Launch one with `swarm run` and it'll appear here."
          className="min-h-[160px]"
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {running.map((row) => (
            <RunningCard key={row.runId} row={row} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}

function RunningCard({ row, now }: { row: PipelineSummary; now: number }): JSX.Element {
  const startedMs = Date.parse(row.startedAt);
  const elapsed = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : undefined;
  return (
    <Link
      to={`/pipelines/${row.runId}`}
      data-testid={`running-card-${row.runId}`}
      className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl"
    >
      <Card size="sm" className="hover:bg-muted/40 transition-colors">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="truncate" title={displayTooltip(row)}>
              {displayTitle(row)}
            </span>
            <Shimmer className="ml-auto text-xs font-medium" as="span">
              running
            </Shimmer>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="font-mono" title={row.runId}>
            {shortenRunId(row.runId)}
          </span>
          <span className="flex items-center gap-3 tabular-nums">
            <span title="elapsed">{formatDuration(elapsed)}</span>
            <span title="events">{row.eventCount} ev</span>
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}

// ── Stats tiles ──────────────────────────────────────────────────────

interface StatsTilesProps {
  stats: ReturnType<typeof computeStats>;
  loading: boolean;
}

function StatsTiles({ stats, loading }: StatsTilesProps): JSX.Element {
  return (
    <section data-testid="stats-tiles" className="flex flex-col gap-3">
      <h2 className="font-heading text-base font-semibold">Overview</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <StatTile
          label="Total runs"
          value={loading ? null : String(stats.totalRuns)}
          icon={<Hash className="size-4" />}
          testId="tile-total"
        />
        <StatTile
          label="Success rate"
          value={loading ? null : formatPercent(stats.successRate)}
          icon={<CheckCircle2 className="size-4" />}
          testId="tile-success"
        />
        <StatTile
          label="Total spend"
          value={loading ? null : formatUsd(stats.totalCostUsd)}
          icon={<DollarSign className="size-4" />}
          testId="tile-spend"
        />
        <StatTile
          label="Total tokens"
          value={loading ? null : formatTokensCompact(stats.totalTokens)}
          icon={<Coins className="size-4" />}
          testId="tile-tokens"
        />
        <StatTile
          label="Avg duration"
          value={loading ? null : stats.avgDurationMs === undefined ? "—" : formatDuration(stats.avgDurationMs)}
          icon={<Timer className="size-4" />}
          testId="tile-duration"
        />
      </div>
    </section>
  );
}

interface StatTileProps {
  label: string;
  /** `null` = loading; renders a skeleton in place of the number. */
  value: string | null;
  icon: JSX.Element;
  testId: string;
}

function StatTile({ label, value, icon, testId }: StatTileProps): JSX.Element {
  return (
    <Card size="sm" data-testid={testId} className="ring-0">
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-xs font-medium text-muted-foreground">
          <span>{label}</span>
          <span aria-hidden="true">{icon}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {value === null ? (
          <Skeleton className="h-7 w-20" />
        ) : (
          <p className="font-heading text-2xl tabular-nums">{value}</p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Format a 0..1 success rate as a whole percent. Locale-aware via
 * Intl.NumberFormat — kept inline (not in lib/format.ts) because Home
 * is the only caller today; promote when a second site needs it.
 */
function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 }).format(value);
}

// ── Recent runs ──────────────────────────────────────────────────────

interface RecentRunsProps {
  rows: PipelineSummary[];
  loading: boolean;
}

function RecentRuns({ rows, loading }: RecentRunsProps): JSX.Element {
  return (
    <section data-testid="recent-runs" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-heading text-base font-semibold">Recent runs</h2>
        <Link to="/pipelines" className="text-xs text-muted-foreground hover:text-foreground">
          View all →
        </Link>
      </div>
      {loading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          data-testid="recent-empty"
          icon={<Play className="size-6" />}
          title="No runs yet"
          description="They'll show up here as soon as `swarm run` records one."
          className="min-h-[160px]"
        />
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <PipelineRow key={row.runId} row={row} variant="compact" />
          ))}
        </div>
      )}
    </section>
  );
}
