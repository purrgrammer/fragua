// Home dashboard — Stats + Runs (running + recent collapsed into one
// section). Overview launcher is temporarily disabled (its POST /jobs
// endpoint is gone); bring it back when the enqueue API is restored.
//
// Cadence: the 5s poll lives on the query factory
// (`queries.runs.list`'s `refetchInterval`). No local timer needed.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  CheckCircle2,
  Coins,
  DollarSign,
  Hash,
  Hourglass,
  Pause,
  Play,
  Target,
  Timer,
  XCircle,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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
import { RunRow } from "../components/RunRow.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { StatTile } from "../components/ui/stat-tile.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { enqueueJob, type RunSummary } from "../lib/api.ts";
import { formatTokensCompact, tokensCompactFormatOptions, usdFormatOptions } from "../lib/format.ts";
import { queries } from "../lib/queries.ts";
import { computeStats } from "../lib/stats.ts";
import { formatDuration } from "../lib/time.ts";
import { useHealth } from "../types/health.ts";

const RECENT_LIMIT = 10;

export function Home(): JSX.Element {
  const { data, isPending } = useQuery(queries.runs.list());

  const rows = data ?? [];
  const running = useMemo(() => rows.filter((r) => r.status === "running"), [rows]);
  const stats = useMemo(() => computeStats(rows), [rows]);
  // Exclude currently-running runs from the recent list so they aren't
  // duplicated above.
  const recent = useMemo(() => rows.filter((r) => r.status !== "running").slice(0, RECENT_LIMIT), [rows]);

  return (
    <div className="flex flex-col gap-8">
      {/* Overview launcher temporarily removed — hits POST /jobs, which
          no longer exists on the daemon. Restore once the enqueue API is
          wired up again. */}
      <StatsTiles stats={stats} loading={isPending} />
      <RunsSection running={running} recent={recent} loading={isPending} />
    </div>
  );
}

// ── Overview launcher ────────────────────────────────────────────────
//
// `daemon === undefined` is the authoritative signal for "read-only
// archive" (plain `swarm serve`), matching the sidebar footer badge.
// We deliberately don't double-probe /jobs — the health response is
// the single source of truth.

function _Overview(): JSX.Element {
  const health = useHealth();
  const daemonOff = health.status === "error" || health.daemon === undefined;

  const qc = useQueryClient();
  const navigate = useNavigate();
  const workflowsQuery = useQuery({
    ...queries.workflows.list(),
    enabled: !daemonOff,
  });
  const workflows = workflowsQuery.data ?? [];

  const [workflow, setWorkflow] = useState<string>("");
  const [input, setInput] = useState<string>("");

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
    mutationFn: (vars: { workflowPath: string; input: string }) =>
      enqueueJob({ workflow: vars.workflowPath, input: vars.input }),
    onSuccess: (data) => {
      setInput("");
      void qc.invalidateQueries({ queryKey: queries.runs.all() });
      void qc.invalidateQueries({ queryKey: queries.jobs.all() });
      navigate(`/runs/${data.runId}`);
    },
  });

  const trimmed = input.trim();
  const canSubmit = !daemonOff && !!workflow && trimmed !== "" && !mutation.isPending;

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text.trim();
    const selected = workflows.find((w) => w.name === workflow);
    if (!selected || text === "") return;
    // Send the filesystem path the worker expects. Newer daemons also
    // accept the bare name, but sending the path works against any
    // running daemon version.
    mutation.mutate({ workflowPath: selected.path, input: text });
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
                  <PromptInputSelectItem key={w.name} value={w.name} data-testid={`overview-workflow-item-${w.name}`}>
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
          <PromptInputSubmit disabled={!canSubmit} data-testid="overview-submit" status={submitStatus} />
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

// ── Runs section (running + recent in one block) ─────────────────────

interface RunsSectionProps {
  running: RunSummary[];
  recent: RunSummary[];
  loading: boolean;
}

function RunsSection({ running, recent, loading }: RunsSectionProps): JSX.Element {
  const hasAny = running.length > 0 || recent.length > 0;
  return (
    <section data-testid="runs-section" className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h2 className="font-heading text-base font-semibold">Runs</h2>
        <Link to="/runs" className="text-xs text-muted-foreground hover:text-foreground">
          View all →
        </Link>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : !hasAny ? (
        <EmptyState
          data-testid="runs-empty"
          icon={<Play className="size-6" />}
          title="No runs yet"
          description="They'll show up here as soon as `swarm run` records one."
          className="min-h-[160px]"
        />
      ) : (
        <div className="flex flex-col gap-2">
          {running.length > 0 && (
            <div data-testid="running-strip" className="flex flex-col gap-2">
              {running.map((row) => (
                <RunRow key={row.runId} row={row} variant="compact" />
              ))}
            </div>
          )}
          {recent.length > 0 && (
            <div className="flex flex-col gap-2">
              {recent.map((row) => (
                <RunRow key={row.runId} row={row} variant="compact" />
              ))}
            </div>
          )}
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

function StatsTiles({ stats, loading }: StatsTilesProps): JSX.Element {
  return (
    <section data-testid="stats-tiles" className="flex flex-col gap-6">
      <h2 className="font-heading text-base font-semibold">Stats</h2>

      <StatsGroup label="Queue" testId="stats-queue">
        <StatTile
          label="Running"
          loading={loading}
          numericValue={stats.running}
          icon={<Play className="size-4" />}
          testId="tile-running"
        />
        <StatTile
          label="Queued"
          loading={loading}
          numericValue={stats.queued}
          icon={<Hourglass className="size-4" />}
          testId="tile-queued"
        />
        <StatTile
          label="Paused"
          loading={loading}
          numericValue={stats.paused}
          icon={<Pause className="size-4" />}
          testId="tile-paused"
        />
        <StatTile
          label="Total runs"
          loading={loading}
          numericValue={stats.totalRuns}
          icon={<Hash className="size-4" />}
          testId="tile-total"
        />
      </StatsGroup>

      <StatsGroup label="Outcomes" testId="stats-outcomes">
        <StatTile
          label="Succeeded"
          loading={loading}
          numericValue={stats.succeeded}
          icon={<CheckCircle2 className="size-4" />}
          testId="tile-succeeded"
        />
        <StatTile
          label="Failed"
          loading={loading}
          numericValue={stats.failed}
          icon={<XCircle className="size-4" />}
          testId="tile-failed"
        />
        <StatTile
          label="Canceled"
          loading={loading}
          numericValue={stats.canceled}
          icon={<Ban className="size-4" />}
          testId="tile-canceled"
        />
        <StatTile
          label="Success rate"
          loading={loading}
          value={formatPercent(stats.successRate)}
          icon={<Target className="size-4" />}
          testId="tile-success"
        />
      </StatsGroup>

      <StatsGroup label="Resources" testId="stats-resources">
        <StatTile
          label="Avg duration"
          loading={loading}
          value={stats.avgDurationMs === undefined ? undefined : formatDuration(stats.avgDurationMs)}
          icon={<Timer className="size-4" />}
          testId="tile-duration"
        />
        <StatTile
          label="Total spend"
          loading={loading}
          numericValue={stats.totalCostUsd}
          format={usdFormatOptions(stats.totalCostUsd ?? 0)}
          icon={<DollarSign className="size-4" />}
          testId="tile-spend"
        />
        <StatTile
          label="Total tokens"
          loading={loading}
          numericValue={stats.totalTokens}
          format={tokensCompactFormatOptions(stats.totalTokens ?? 0)}
          icon={<Coins className="size-4" />}
          testId="tile-tokens"
        />
        <StatTile
          label="Cache hit rate"
          loading={loading}
          value={stats.cacheHitRate === undefined ? undefined : formatPercent(stats.cacheHitRate)}
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
      </StatsGroup>
    </section>
  );
}

interface StatsGroupProps {
  label: string;
  testId: string;
  children: React.ReactNode;
}

function StatsGroup({ label, testId, children }: StatsGroupProps): JSX.Element {
  return (
    <div data-testid={testId} className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{children}</div>
    </div>
  );
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 }).format(value);
}
