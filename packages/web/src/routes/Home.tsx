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

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins, Database, DollarSign, Play } from "lucide-react";
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
import { GlobalFeed } from "../components/GlobalFeed.tsx";
import { Inbox } from "../components/Inbox.tsx";
import { RunRow } from "../components/RunRow.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { SectionTitle } from "../components/ui/section-title.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { StatTile } from "../components/ui/stat-tile.tsx";
import { enqueueJob, type RunSummary } from "../lib/api.ts";
import { percentFormatOptions, tokensCompactFormatOptions, usdFormatOptions } from "../lib/format.ts";
import { queries } from "../lib/queries.ts";
import { computeStats } from "../lib/stats.ts";
import { useHealth } from "../types/health.ts";

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
      {/* Overview launcher temporarily removed — hits POST /jobs, which
          no longer exists on the daemon. Restore once the enqueue API is
          wired up again. */}
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

// ── Running section (currently-executing runs only) ──────────────────
//
// No pagination, no "recent" tail — the Control Center shows what's
// in flight right now. Archive browsing lives on /runs.

interface RunningSectionProps {
  running: RunSummary[];
  loading: boolean;
}

function RunningSection({ running, loading }: RunningSectionProps): JSX.Element {
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
      ) : running.length === 0 ? (
        <EmptyState
          data-testid="running-empty"
          icon={<Play className="size-6" />}
          title="Nothing running"
          description="Active runs appear here while they execute."
          className="min-h-[120px]"
        />
      ) : (
        <div data-testid="running-strip" className="flex flex-col gap-2">
          {running.map((row) => (
            <RunRow key={row.runId} row={row} variant="compact" />
          ))}
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
  return [`input  ${fmt.format(stats.totalInputTokens)}`, `output ${fmt.format(stats.totalOutputTokens)}`].join(" · ");
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
          label="Running"
          loading={loading}
          numericValue={stats.running}
          icon={<Play className="size-4" />}
          testId="tile-running"
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
          label="Tokens"
          loading={loading}
          numericValue={stats.freshTokens}
          format={tokensCompactFormatOptions(stats.freshTokens ?? 0)}
          icon={<Coins className="size-4" />}
          hint={tokensTooltip(stats)}
          testId="tile-tokens"
        />
        <StatTile
          label="Cache hit rate"
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
