// GET /runs/:id[/:view] → run detail page.
//
// Tabs (`:view` param driven, default `conversation`):
//   Conversation — messages-table-driven transcript (AgentMessage per row)
//   Graph        — live DAG with node inspector
//   Cost         — per-LLM-call cost + context-window breakdown
//
// (The raw event log was intentionally removed: a long run's event
// stream is multi-megabyte and the table view scaled badly. Use
// `curl /api/runs/:id/events.json` for ad-hoc debugging.)
//
// Header shows a bento stats strip using the shared `StatTile` — same
// design language as Home's dashboard. The mix of stats is picked for
// a run's essentials: status, duration, cost, tokens, current node.

import { parseDotSource } from "@swarm/core";
import { useQuery } from "@tanstack/react-query";
import { Coins, DollarSign, Timer } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { CostInspector } from "../components/CostInspector.tsx";
import { GraphView } from "../components/GraphView.tsx";
import { NodeInspector } from "../components/NodeInspector.tsx";
import { RunConversation } from "../components/RunConversation.tsx";
import { RunStatusBadge } from "../components/RunStatusBadge.tsx";
import SteerInput from "../components/SteerInput.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { StatTile } from "../components/ui/stat-tile.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import type { RunDetail as RunDetailT } from "../lib/api.ts";
import { formatCacheHitRate, tokensCompactFormatOptions, usdFormatOptions } from "../lib/format.ts";
import { queries } from "../lib/queries.ts";
import { formatDateTime, formatDuration, formatRelative } from "../lib/time.ts";
import { mergeDetail } from "../lib/useDetailOverlay.ts";
import type { CostAggregate } from "../lib/useLiveCostAggregate.ts";
import { useNow } from "../lib/useNow.ts";
import { useRunLive } from "../lib/useRunLive.ts";

const VIEWS = ["conversation", "graph", "cost"] as const;
type TabId = (typeof VIEWS)[number];

/** Statuses where the run is still progressing and the clock should tick. */
const LIVE_STATUSES = new Set<string>(["queued", "running", "paused"]);

/** Statuses where no further events will ever arrive. The SSE socket is
 * skipped entirely so we don't waste a server connection per historical
 * run view. */
const TERMINAL_STATUSES = new Set<string>(["success", "fail", "canceled"]);

function isTabId(x: string | undefined): x is TabId {
  return !!x && (VIEWS as readonly string[]).includes(x);
}

export function RunDetail(): JSX.Element {
  const { id = "", view: rawView } = useParams();
  const navigate = useNavigate();

  const view: TabId = isTabId(rawView) ? rawView : "conversation";
  const shouldCanonicalize = !!id && rawView !== view;

  // All hooks before any conditional return — Rules of Hooks.
  // Snapshot is fetched ONCE at mount and never refetched: SSE events
  // are folded into `detailOverlay` and merged in-memory via
  // `mergeDetail` for display. Previously this effect re-fired
  // `qc.refetchQueries(detail)` on every SSE frame — on a 1k-events/sec
  // run that was a thousand full-payload refetches per second.
  const { data: snapshot, isError } = useQuery({ ...queries.runs.detail(id), enabled: !!id });
  // Tri-state: `undefined` while the snapshot is loading; `true` only
  // when we've confirmed a terminal status. `useRunLive` defers opening
  // SSE until this lands as a boolean so we don't flash a transient
  // connection during the snapshot's first ~50ms.
  const isTerminal: boolean | undefined = snapshot == null ? undefined : TERMINAL_STATUSES.has(snapshot.status);
  const {
    messages,
    streaming,
    status: liveStatus,
    totalEvents,
    controlEvents,
    liveCost,
    detailOverlay,
  } = useRunLive(id || null, {
    sinceSeq: snapshot?.lastEventSeq,
    terminal: isTerminal,
  });
  const isLoading = liveStatus === "loading";
  const isLive = liveStatus === "live" || liveStatus === "loading";
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Single source of truth for downstream consumers. `mergeDetail`
  // returns the snapshot reference unchanged when the overlay is empty,
  // so `useMemo` only allocates when state actually moves.
  const detail = useMemo<RunDetailT | undefined>(
    () => (snapshot != null ? mergeDetail(snapshot, detailOverlay) : undefined),
    [snapshot, detailOverlay],
  );

  const handleNodeClick = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    document.getElementById(`node-${nodeId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

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
      <DetailHeader detail={detail ?? null} id={id} isLive={isLive} liveCost={liveCost} />

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
            <TabsTrigger value="graph" data-testid="view-tab-graph">
              Graph
            </TabsTrigger>
            <TabsTrigger value="cost" data-testid="view-tab-cost">
              Cost
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
            <TabsContent value="graph" className="h-full">
              <RunGraphTab detail={detail ?? null} selectedNodeId={selectedNodeId} onSelect={handleNodeClick} />
            </TabsContent>
            <TabsContent value="cost" className="h-full">
              <CostInspector runId={id} totalEvents={totalEvents} isLive={isLive} />
            </TabsContent>
          </div>

          {view === "conversation" && detail?.status === "running" && <SteerInput runId={id} events={controlEvents} />}
        </Tabs>
      )}
    </section>
  );
}

// ─── Header: run-level title + stats strip ────────────────────────

function DetailHeader({
  detail,
  id,
  isLive,
  liveCost,
}: {
  detail: RunDetailT | null;
  id: string;
  isLive: boolean;
  liveCost: CostAggregate;
}): JSX.Element {
  const showLive = isLive && detail?.status === "running";
  const nodes = detail?.nodes ?? [];
  const runningNode = nodes.find((n) => n.state === "running");
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
            : null;
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
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-mono text-xs text-muted-foreground" title={id}>
            {shortenRunId(id)}
          </span>
          {detail && (
            <RunStatusBadge
              status={detail.status}
              data-testid="detail-status"
              className="px-1.5 py-0.5 text-[0.65rem]"
            />
          )}
          {detail && currentLabel && (
            <span
              data-testid="detail-current-node-inline"
              className="shrink-0 max-w-[16rem] truncate rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.65rem] text-muted-foreground"
              title={currentLabel}
            >
              {currentLabel}
            </span>
          )}
        </div>
      </div>
      <StatsStrip detail={detail} liveCost={liveCost} />
    </header>
  );
}

export function StatsStrip({ detail, liveCost }: { detail: RunDetailT | null; liveCost?: CostAggregate }): JSX.Element {
  const loading = detail == null;
  const isLiveRun = detail != null && LIVE_STATUSES.has(detail.status);
  const now = useNow(1_000, isLiveRun);
  const durationMs = isLiveRun ? Math.max(0, now - Date.parse(detail.startedAt)) : detail?.durationMs;

  // Prefer the live aggregate when at least one cost.recorded event has
  // arrived; fall back to the server snapshot so terminal/initial renders
  // still show data. The live values converge with the snapshot once the
  // run reaches a terminal fact.
  const hasLive =
    liveCost != null && liveCost.totalCostUsd + liveCost.totalInputTokens + liveCost.totalOutputTokens > 0;
  const costUsd = hasLive ? liveCost.totalCostUsd : (detail?.costUsd ?? 0);
  const inputTokens = hasLive ? liveCost.totalInputTokens : (detail?.inputTokens ?? 0);
  const outputTokens = hasLive ? liveCost.totalOutputTokens : (detail?.outputTokens ?? 0);
  // Preserve undefined when the snapshot omits cacheReadTokens and no live
  // events have arrived — formatCacheHitRate returns '—' for undefined,
  // which is the right fallback for pre-split runs.
  const cacheReadTokens: number | undefined = hasLive ? liveCost.totalCacheReadTokens : detail?.cacheReadTokens;
  const totalTokens = inputTokens + outputTokens;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="detail-stats">
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
        numericValue={costUsd}
        format={usdFormatOptions(costUsd)}
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
        hint={detail ? `input ${inputTokens.toLocaleString()} · output ${outputTokens.toLocaleString()}` : undefined}
      />
      <StatTile
        label="Cache hit rate"
        loading={loading}
        value={formatCacheHitRate(cacheReadTokens, inputTokens)}
        testId="detail-cache-tile"
        hint={
          detail
            ? `cache read ${(cacheReadTokens ?? 0).toLocaleString()} · input ${inputTokens.toLocaleString()}`
            : undefined
        }
      />
    </div>
  );
}

// ─── Graph tab ────────────────────────────────────────────────────

function RunGraphTab({
  detail,
  selectedNodeId,
  onSelect,
}: {
  detail: RunDetailT | null;
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
