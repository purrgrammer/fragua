// Home dashboard — four sections. Overview is a workflow launcher
// that drives `POST /jobs` through the same query cache the rest of
// the page reads, so a successful submit triggers an invalidate →
// refetch and the new run surfaces in the Running strip without a
// reload. Running + Stats + Recent are three projections of
// `GET /pipelines`.
//
// Layout (top → bottom): Overview, Running, Stats, Recent.
//
// Cadence: the 5s poll lives on the query factory
// (`queries.pipelines.list`'s `refetchInterval`). No local timer needed.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Coins, DollarSign, Hash, Play, Timer, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Message, MessageContent } from "../components/ai-elements/message.tsx";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputHeader,
  type PromptInputMessage,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "../components/ai-elements/prompt-input.tsx";
import { Shimmer } from "../components/ai-elements/shimmer.tsx";
import { displayTitle, displayTooltip, PipelineRow, shortenRunId } from "../components/PipelineRow.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { enqueueJob, type PipelineSummary } from "../lib/api.ts";
import { formatTokensCompact, formatUsd } from "../lib/format.ts";
import { queries } from "../lib/queries.ts";
import { computeStats } from "../lib/stats.ts";
import { formatDuration } from "../lib/time.ts";
import { useHealth } from "../types/health.ts";

const RECENT_LIMIT = 10;

export function Home(): JSX.Element {
  const { data, isPending } = useQuery(queries.pipelines.list());
  const [now, setNow] = useState<number>(() => Date.now());

  // One-second ticker keeps the "elapsed" on the running strip live.
  // Not a query — it's derived from `Date.now()`, which doesn't belong in
  // the cache.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  const rows = data ?? [];
  const running = useMemo(() => rows.filter((r) => r.status === "running"), [rows]);
  const stats = useMemo(() => computeStats(rows), [rows]);

  return (
    <div className="flex flex-col gap-8">
      <Overview />
      <RunningStrip running={running} now={now} loading={isPending} />
      <StatsTiles stats={stats} loading={isPending} />
      <RecentRuns rows={rows.slice(0, RECENT_LIMIT)} loading={isPending} />
    </div>
  );
}

// ── Overview launcher ────────────────────────────────────────────────
//
// `daemon === undefined` is the authoritative signal for "read-only
// archive" (plain `swarm serve`), matching the sidebar footer badge.
// We deliberately don't double-probe /jobs — the health response is
// the single source of truth.

function Overview(): JSX.Element {
  const health = useHealth();
  const daemonOff = health.status === "error" || health.daemon === undefined;

  const qc = useQueryClient();
  const workflowsQuery = useQuery({
    ...queries.workflows.list(),
    enabled: !daemonOff,
  });
  const workflows = workflowsQuery.data ?? [];

  const [workflow, setWorkflow] = useState<string>("");
  const [input, setInput] = useState<string>("");
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);

  // Default-select the first workflow once the list arrives. Seeded
  // only on the transition from "no selection" → "have one"; never
  // overwritten by refetches.
  useEffect(() => {
    if (!workflow && workflows.length > 0) {
      const first = workflows[0];
      if (first) setWorkflow(first.name);
    }
  }, [workflow, workflows]);

  const mutation = useMutation({
    mutationFn: (vars: { workflow: string; input: string }) =>
      enqueueJob({ workflow: vars.workflow, input: vars.input }),
    onSuccess: (_data, vars) => {
      setLastPrompt(vars.input);
      setInput("");
      void qc.invalidateQueries({ queryKey: queries.pipelines.all() });
      void qc.invalidateQueries({ queryKey: queries.jobs.all() });
    },
  });

  const trimmed = input.trim();
  const canSubmit = !daemonOff && !!workflow && trimmed !== "" && !mutation.isPending;

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (!workflow || text === "") return;
    mutation.mutate({ workflow, input: text });
  };

  const submitStatus: "submitted" | "error" | undefined = mutation.isPending
    ? "submitted"
    : mutation.isError
      ? "error"
      : undefined;

  const errorMessage =
    mutation.error instanceof Error ? mutation.error.message : mutation.error ? String(mutation.error) : null;

  return (
    <section data-testid="overview" className="flex flex-col gap-[var(--sw-space-3)]">
      <h2 className="font-heading text-base font-semibold">Overview</h2>

      {lastPrompt !== null && (
        <Message from="user" data-testid="overview-last-prompt">
          <MessageContent>
            <p className="whitespace-pre-wrap">{lastPrompt}</p>
          </MessageContent>
        </Message>
      )}

      <PromptInput onSubmit={handleSubmit} data-testid="overview-form">
        <PromptInputHeader>
          <PromptInputTools>
            <PromptInputSelect
              value={workflow}
              // Radix Select's items live inside a portal that only
              // mounts while the menu is open. On mount, with a seeded
              // `value`, Radix can't find a matching item yet and fires
              // `onValueChange("")` to "clear" — which used to race our
              // seeding effect into an infinite loop. Dropping the empty
              // callback lets the seeded value stick until the user
              // actually picks something.
              onValueChange={(v) => {
                if (v) setWorkflow(v);
              }}
              disabled={daemonOff}
            >
              <PromptInputSelectTrigger data-testid="overview-workflow-trigger" aria-label="Workflow">
                <PromptInputSelectValue placeholder="Select workflow…" />
              </PromptInputSelectTrigger>
              <PromptInputSelectContent>
                {workflows.map((w) => (
                  <PromptInputSelectItem
                    key={w.name}
                    value={w.name}
                    data-testid={`overview-workflow-item-${w.name}`}
                  >
                    {w.label ?? w.name}
                  </PromptInputSelectItem>
                ))}
              </PromptInputSelectContent>
            </PromptInputSelect>
          </PromptInputTools>
        </PromptInputHeader>

        <PromptInputTextarea
          placeholder={daemonOff ? "Daemon not running" : "Describe what the workflow should do…"}
          disabled={daemonOff}
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          data-testid="overview-input"
        />

        <PromptInputFooter>
          <PromptInputTools />
          <PromptInputSubmit
            disabled={!canSubmit}
            data-testid="overview-submit"
            status={submitStatus}
          />
        </PromptInputFooter>
      </PromptInput>

      {daemonOff && (
        <p className="text-xs text-[var(--sw-muted)]" data-testid="overview-daemon-off">
          Daemon not running — start <code className="font-mono">swarm daemon</code> to launch workflows from here.
        </p>
      )}

      {errorMessage && !daemonOff && (
        <p className="text-xs text-[var(--sw-accent-error)]" role="alert" data-testid="overview-error">
          {errorMessage}
        </p>
      )}
    </section>
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
      <h2 className="font-heading text-base font-semibold">Stats</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
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
          label="Cache hit rate"
          value={loading ? null : stats.cacheHitRate === undefined ? "—" : formatPercent(stats.cacheHitRate)}
          hint={
            loading
              ? undefined
              : `cached: ${formatTokensCompact(stats.totalCacheReadTokens)} read · ${formatTokensCompact(
                  stats.totalCacheWriteTokens,
                )} written`
          }
          icon={<Zap className="size-4" />}
          testId="tile-cache"
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
  /** Optional secondary line, rendered under the main value in muted text. */
  hint?: string;
  icon: JSX.Element;
  testId: string;
}

function StatTile({ label, value, hint, icon, testId }: StatTileProps): JSX.Element {
  return (
    <Card size="sm" data-testid={testId} className="ring-0" title={hint}>
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
