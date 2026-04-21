// GET /runs/:id[/:view] → run detail page.
//
// Tabs (`:view` param driven, default `conversation`):
//   Conversation — messages-table-driven transcript (AgentMessage per row)
//   Events       — raw store event log (fact.* / intent.* / observability.*)
//   Graph        — live DAG with node inspector
//   Steps        — per-step LLM context dump
//
// Header shows a bento stats strip using the shared `StatTile` — same
// design language as Home's dashboard. The mix of stats is picked for
// a run's essentials: status, duration, cost, tokens, current node.

import { parseDotSource } from "@swarm/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, CheckCircle2, Coins, DollarSign, Timer } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { EventLog } from "../components/EventLog.tsx";
import { GraphView } from "../components/GraphView.tsx";
import { NodeInspector } from "../components/NodeInspector.tsx";
import { RunConversation } from "../components/RunConversation.tsx";
import { RunStatusBadge } from "../components/RunStatusBadge.tsx";
import SteerInput from "../components/SteerInput.tsx";
import { StepInspector } from "../components/StepInspector.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { StatTile } from "../components/ui/stat-tile.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import type { RunDetail as RunDetailT } from "../lib/api.ts";
import { tokensCompactFormatOptions, usdFormatOptions } from "../lib/format.ts";
import { queries } from "../lib/queries.ts";
import { formatDateTime, formatDuration, formatRelative } from "../lib/time.ts";
import { useRunLive } from "../lib/useRunLive.ts";

const VIEWS = ["conversation", "events", "graph", "steps"] as const;
type TabId = (typeof VIEWS)[number];

/** Statuses where the run is still progressing and the clock should tick. */
const LIVE_STATUSES = new Set<string>(["queued", "running", "paused"]);

/**
 * Returns a `Date.now()`-style timestamp that re-renders every `intervalMs`.
 * When `enabled` is false the interval is never created (zero re-render cost).
 */
function useNow(intervalMs: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

function isTabId(x: string | undefined): x is TabId {
  return !!x && (VIEWS as readonly string[]).includes(x);
}

export function RunDetail(): JSX.Element {
  const { id = "", view: rawView } = useParams();
  const navigate = useNavigate();

  const view: TabId = isTabId(rawView) ? rawView : "conversation";
  const shouldCanonicalize = !!id && rawView !== view;

  // All hooks before any conditional return — Rules of Hooks.
  const { messages, streaming, status: liveStatus, totalEvents, controlEvents } = useRunLive(id || null);
  const isLoading = liveStatus === "loading";
  const isLive = liveStatus === "live" || liveStatus === "loading";
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const handleNodeClick = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    document.getElementById(`node-${nodeId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const qc = useQueryClient();
  const { data: detail, isError } = useQuery({ ...queries.runs.detail(id), enabled: !!id });

  // biome-ignore lint/correctness/useExhaustiveDependencies: totalEvents is the intentional trigger.
  useEffect(() => {
    if (id) void qc.refetchQueries({ queryKey: queries.runs.detail(id).queryKey });
  }, [totalEvents]);

  // Canonicalize the URL: bare /runs/:id → /runs/:id/conversation,
  // invalid view → same. Runs AFTER all hooks to stay rules-compliant.
  if (shouldCanonicalize) return <Navigate to={`/runs/${id}/${view}`} replace />;

  if (!id) {
    return (
      <EmptyState
        data-testid="detail-missing-id"
        title="Missing run id"
        description="The URL didn't include a run identifier."
        action={
          <Link to="/runs" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
            ← all runs
          </Link>
        }
      />
    );
  }

  return (
    <section className="flex h-full w-full min-w-0 flex-col gap-4">
      <DetailHeader detail={detail ?? null} id={id} isLive={isLive} />

      {isError && !detail ? (
        <EmptyState
          data-testid="detail-error"
          title="Couldn't load this run"
          description="The server didn't return details for this run."
          action={
            <Link to="/runs" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
              ← all runs
            </Link>
          }
        />
      ) : (
        <Tabs
          value={view}
          onValueChange={(next) => navigate(`/runs/${id}/${next}`, { replace: true })}
          className="flex min-h-0 flex-1 flex-col gap-3"
        >
          <TabsList variant="line" className="self-start">
            <TabsTrigger value="conversation" data-testid="view-tab-conversation">
              Conversation
            </TabsTrigger>
            <TabsTrigger value="events" data-testid="view-tab-events">
              Events
            </TabsTrigger>
            <TabsTrigger value="graph" data-testid="view-tab-graph">
              Graph
            </TabsTrigger>
            <TabsTrigger value="steps" data-testid="view-tab-steps">
              Steps
            </TabsTrigger>
          </TabsList>

          <div
            data-testid={`${view}-region`}
            className="min-h-0 min-w-0 flex-1 overflow-auto rounded-md border bg-background"
          >
            <TabsContent value="conversation" className="h-full">
              <RunConversation
                messages={messages}
                streaming={streaming}
                nodeStates={detail?.nodes}
                isLive={isLive}
                isLoading={isLoading}
                userInput={detail?.input ?? null}
              />
            </TabsContent>
            <TabsContent value="events" className="h-full">
              <EventLog runId={id} refetchKey={totalEvents} />
            </TabsContent>
            <TabsContent value="graph" className="h-full">
              <RunGraphTab
                detail={detail ?? null}
                refetchKey={totalEvents}
                selectedNodeId={selectedNodeId}
                onSelect={handleNodeClick}
              />
            </TabsContent>
            <TabsContent value="steps" className="h-full">
              <StepInspector runId={id} totalEvents={totalEvents} />
            </TabsContent>
          </div>

          {view === "conversation" && detail?.status === "running" && <SteerInput runId={id} events={controlEvents} />}
        </Tabs>
      )}
    </section>
  );
}

// ─── Header: run-level title + stats strip ────────────────────────

function DetailHeader({ detail, id, isLive }: { detail: RunDetailT | null; id: string; isLive: boolean }): JSX.Element {
  const showLive = isLive && detail?.status === "running";
  return (
    <header className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-baseline gap-2">
        <Link to="/runs" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
          ← all runs
        </Link>
        {detail?.workflowName && (
          <>
            <span className="text-xs text-muted-foreground/40">·</span>
            <span className="truncate text-xs text-muted-foreground" title={detail.workflow ?? ""}>
              {detail.workflowName}
            </span>
          </>
        )}
        {showLive && (
          <>
            <span className="text-xs text-muted-foreground/40">·</span>
            <span
              data-testid="detail-live-pill"
              className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-violet-700 dark:text-violet-300"
            >
              <span className="sw-pulse inline-block size-1.5 rounded-full bg-violet-500 ring-2 ring-violet-400/30" />
              live
            </span>
          </>
        )}
      </div>
      <div className="min-w-0">
        <h2 className="truncate text-lg font-semibold" title={detail ? headingTitle(detail) : id}>
          {detail ? headingText(detail) : shortenRunId(id)}
        </h2>
        <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={id}>
          {shortenRunId(id)}
        </p>
      </div>
      <StatsStrip detail={detail} />
    </header>
  );
}

function StatsStrip({ detail }: { detail: RunDetailT | null }): JSX.Element {
  const loading = detail == null;
  const isLiveRun = detail != null && LIVE_STATUSES.has(detail.status);
  const now = useNow(1_000, isLiveRun);
  const durationMs = isLiveRun ? Math.max(0, now - Date.parse(detail.startedAt)) : detail?.durationMs;
  const totalTokens = detail ? detail.inputTokens + detail.outputTokens : 0;
  const nodes = detail?.nodes ?? [];
  const runningNode = nodes.find((n) => n.state === "running");
  const completedNodes = nodes.filter((n) => n.state === "completed").length;
  const currentLabel = runningNode
    ? runningNode.nodeId
    : detail?.status === "queued"
      ? "queued"
      : detail?.status === "success"
        ? "done"
        : detail?.status === "fail"
          ? "halted"
          : detail?.status === "canceled"
            ? "canceled"
            : "—";

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5" data-testid="detail-stats">
      <StatTile
        label="Status"
        loading={loading}
        testId="detail-status-tile"
        icon={<Activity className="size-4" />}
        hint={detail ? `Status: ${detail.status}` : undefined}
      >
        {detail ? <RunStatusBadge status={detail.status} data-testid="detail-status" /> : null}
      </StatTile>
      <StatTile
        label="Duration"
        loading={loading}
        value={detail ? formatDuration(durationMs) : undefined}
        testId="detail-duration-tile"
        icon={<Timer className="size-4" />}
        hint={detail ? `started ${formatRelative(detail.startedAt)} (${formatDateTime(detail.startedAt)})` : undefined}
      />
      <StatTile
        label="Cost"
        loading={loading}
        numericValue={detail?.costUsd ?? 0}
        format={usdFormatOptions(detail?.costUsd ?? 0)}
        testId="detail-cost-tile"
        icon={<DollarSign className="size-4" />}
      />
      <StatTile
        label="Tokens"
        loading={loading}
        numericValue={totalTokens}
        format={tokensCompactFormatOptions(totalTokens)}
        testId="detail-tokens-tile"
        icon={<Coins className="size-4" />}
        hint={
          detail
            ? `input ${detail.inputTokens.toLocaleString()} · output ${detail.outputTokens.toLocaleString()}`
            : undefined
        }
      />
      <StatTile
        label="Current node"
        loading={loading}
        value={currentLabel}
        testId="detail-current-tile"
        icon={<CheckCircle2 className="size-4" />}
        hint={
          nodes.length > 0
            ? `${completedNodes}/${nodes.length} nodes completed`
            : detail?.status
              ? `run is ${detail.status}`
              : undefined
        }
      />
    </div>
  );
}

// ─── Graph tab ────────────────────────────────────────────────────

function RunGraphTab({
  detail,
  refetchKey,
  selectedNodeId,
  onSelect,
}: {
  detail: RunDetailT | null;
  refetchKey: number;
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const graph = useMemo(() => {
    if (!detail?.workflowSource) return null;
    try {
      return parseDotSource(detail.workflowSource);
    } catch {
      return null;
    }
  }, [detail?.workflowSource]);

  const activeNodeId = detail?.nodes.find((n) => n.state === "running")?.nodeId ?? null;
  const selected = selectedNodeId && graph ? (graph.nodes[selectedNodeId] ?? null) : null;
  const selectedState = selectedNodeId ? (detail?.nodes.find((n) => n.nodeId === selectedNodeId) ?? null) : null;

  return (
    <div className="grid h-full min-h-[480px] grid-cols-1 gap-4 p-2 md:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-h-[480px] min-w-0">
        {detail ? (
          <GraphView
            detail={detail}
            orientation="TB"
            refetchKey={refetchKey}
            activeNodeId={activeNodeId}
            selectedNodeId={selectedNodeId}
            onNodeClick={onSelect}
          />
        ) : null}
      </div>
      <NodeInspector node={selected} state={selectedState} />
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

const RUN_ID_SHORT_LEN = 8;

function shortenRunId(runId: string): string {
  return runId.length > RUN_ID_SHORT_LEN ? runId.slice(0, RUN_ID_SHORT_LEN) : runId;
}

function headingText(detail: RunDetailT): string {
  if (detail.title && detail.title.length > 0) return detail.title;
  if (detail.input && detail.input.length > 0) {
    const single = detail.input.replace(/\s+/g, " ").trim();
    return single.length > 80 ? `${single.slice(0, 79)}…` : single;
  }
  return shortenRunId(detail.runId);
}

function headingTitle(detail: RunDetailT): string {
  if (detail.title && detail.title.length > 0) return detail.title;
  if (detail.input && detail.input.length > 0) {
    const single = detail.input.replace(/\s+/g, " ").trim();
    return single.length > 80 ? `${single.slice(0, 79)}…` : single;
  }
  return detail.runId;
}
