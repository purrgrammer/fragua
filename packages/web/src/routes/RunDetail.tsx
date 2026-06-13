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

import { parseWorkflow } from "@fragua/core";
import { SETTLED_STATUSES } from "@fragua/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins, Database, DollarSign, Timer } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { CostInspector } from "../components/CostInspector.tsx";
import { CrashRequeueNotice } from "../components/CrashRequeueNotice.tsx";
import { GraphView } from "../components/GraphView.tsx";
import { ImportedBadge } from "../components/ImportedBadge.tsx";
import { NodeInspector } from "../components/NodeInspector.tsx";
import { ProjectLink } from "../components/ProjectLink.tsx";
import { RunControls } from "../components/RunControls.tsx";
import { RunConversation } from "../components/RunConversation.tsx";
import { hasDiff, RunDiffTab } from "../components/RunDiffTab.tsx";
import { RunHaltedNotice } from "../components/RunHaltedNotice.tsx";
import { RunPausedNotice } from "../components/RunPausedNotice.tsx";
import { RunStatusBadge } from "../components/RunStatusBadge.tsx";
import SteerInput from "../components/SteerInput.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet.tsx";
import { StatTile } from "../components/ui/stat-tile.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import { WorkflowLink } from "../components/WorkflowLink.tsx";
import { ApiError, type RunDetail as RunDetailT } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { percentFormatOptions, tokensCompactFormatOptions, usdFormatOptions } from "../lib/format.ts";
import { mapStatus } from "../lib/humanize.ts";
import { queries } from "../lib/queries.ts";
import { shortRunId } from "../lib/runId.ts";
import { formatDateTime, formatDuration, formatRelative } from "../lib/time.ts";
import { mergeDetail } from "../lib/useDetailOverlay.ts";
import type { CostAggregate } from "../lib/useLiveCostAggregate.ts";
import { useNow } from "../lib/useNow.ts";
import { useRunLive } from "../lib/useRunLive.ts";

const VIEWS = ["conversation", "graph", "cost", "diff"] as const;
type TabId = (typeof VIEWS)[number];

/** Statuses where the run is still progressing and the clock should tick.
 * `paused` is excluded — a paused run isn't doing work, so the duration
 * tile should freeze at the moment of the pause fact (the snapshot's
 * `durationMs` already reflects `lastEvent - firstEvent`). */
const LIVE_STATUSES = new Set<string>(["queued", "running"]);

/** UI statuses where the SSE socket is skipped entirely so we don't waste a
 * server connection per settled run view. Derived from the canonical
 * `SETTLED_STATUSES` tuple (terminal + quarantined) projected through the
 * raw→UI `mapStatus` — resolves to {success, fail, canceled} and can't drift
 * from the lifecycle taxonomy. */
const TERMINAL_STATUSES = new Set<string>(SETTLED_STATUSES.map(mapStatus));

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
  // `mergeDetail` for display, avoiding a full-payload refetch on every
  // SSE frame.
  const { data: snapshot, isError, error } = useQuery({ ...queries.runs.detail(id), enabled: !!id });

  // Tri-state: `undefined` while the snapshot is loading; `true` only
  // when we've confirmed a terminal status. `useRunLive` defers opening
  // SSE until this lands as a boolean so we don't flash a transient
  // connection during the snapshot's first ~50ms.
  const isTerminal: boolean | undefined = snapshot == null ? undefined : TERMINAL_STATUSES.has(snapshot.status);

  const {
    messages,
    messagesError,
    streamingByNode,
    toolStreams,
    status: liveStatus,
    totalEvents,
    liveCost,
    detailOverlay,
  } = useRunLive(id || null, {
    sinceSeq: snapshot?.lastEventSeq,
    terminal: isTerminal,
  });
  const isLoading = liveStatus === "loading";
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Single source of truth for downstream consumers. `mergeDetail`
  // returns the snapshot reference unchanged when the overlay is empty,
  // so `useMemo` only allocates when state actually moves.
  const detail = useMemo<RunDetailT | undefined>(
    () => (snapshot != null ? mergeDetail(snapshot, detailOverlay) : undefined),
    [snapshot, detailOverlay],
  );

  const activeNodeIds = useMemo<ReadonlySet<string>>(() => {
    return new Set<string>((detail?.nodes ?? []).filter((n) => n.state === "running").map((n) => n.nodeId));
  }, [detail?.nodes]);

  const { data: diffSnapshots } = useQuery({
    ...queries.runs.snapshots(id),
    enabled: !!id && detail?.cwd != null,
  });
  // Hide the tab only once snapshots have resolved AND no snapshot has any
  // file changes. While the query is still pending (undefined) we render the
  // tab so it doesn't flicker hidden→shown on first load. Counts only diffable
  // snapshots — a step with no committed/uncommitted changes would just
  // duplicate the prior snapshot's diff vs base, so it doesn't qualify the
  // tab on its own.
  const diffableSnapshotCount = (diffSnapshots ?? []).filter(hasDiff).length;
  const showDiffTab = detail?.cwd != null && (diffSnapshots === undefined || diffableSnapshotCount > 0);

  // `isLive` here means "actively dispatching", not just "SSE connected".
  // A paused run keeps the SSE socket open (so resume facts still arrive)
  // but isn't producing tokens, so streaming labels / pulses must stop.
  // Reads the overlay-merged status so the badge flips the moment a
  // pause / resume / cancel fact lands, without waiting for a refetch.
  const isLive = (liveStatus === "live" || liveStatus === "loading") && detail?.status === "running";
  // The run is still producing events server-side but the SSE stream is
  // down (transient error, or closed awaiting backoff-reconnect). The
  // page is degraded — say so where the live pill normally sits instead
  // of going visually dark. `useEventSource` keeps reconnecting; this
  // yields back to the live pill the moment the stream recovers.
  const isReconnecting = (liveStatus === "error" || liveStatus === "closed") && detail?.status === "running";

  const qc = useQueryClient();
  const prevNodeStatesRef = useRef<typeof detailOverlay.nodeStates>(detailOverlay.nodeStates);
  const prevOverlayStatusRef = useRef<typeof detailOverlay.status>(detailOverlay.status);
  useEffect(() => {
    const prevNodeStates = prevNodeStatesRef.current;
    const prevStatus = prevOverlayStatusRef.current;
    prevNodeStatesRef.current = detailOverlay.nodeStates;
    prevOverlayStatusRef.current = detailOverlay.status;

    const runTerminated =
      detailOverlay.status !== null &&
      detailOverlay.status !== prevStatus &&
      (detailOverlay.status === "success" || detailOverlay.status === "fail" || detailOverlay.status === "canceled");

    let nodeFinished = false;
    for (const [key, entry] of detailOverlay.nodeStates) {
      const prev = prevNodeStates.get(key);
      if (
        (entry.state === "completed" || entry.state === "failed") &&
        (prev === undefined || prev.state !== entry.state)
      ) {
        nodeFinished = true;
        break;
      }
    }

    if (!runTerminated && !nodeFinished) return;
    if (!id) return;

    void qc.invalidateQueries({ queryKey: [...queries.runs.all(), id, "snapshots"] });
    void qc.invalidateQueries({ queryKey: [...queries.runs.all(), id, "snapshot-diff"] });
  }, [detailOverlay.nodeStates, detailOverlay.status, id, qc]);

  const handleNodeClick = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    document.getElementById(`node-${nodeId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  const handleDeselect = useCallback(() => setSelectedNodeId(null), []);

  // Canonicalize the URL: bare /runs/:id → /runs/:id/conversation,
  // invalid view → same. Runs AFTER all hooks to stay rules-compliant.
  if (shouldCanonicalize) return <Navigate to={`/runs/${id}/${view}`} replace />;

  // Guard: the diff tab is only valid for runs that have a cwd AND at least
  // one diffable snapshot. Redirect away from a stale bookmark to /runs/:id/diff
  // once we can prove the tab won't render — either the run has no cwd at all
  // (the snapshots query is disabled so it stays undefined) or snapshots have
  // resolved to zero diffable rows.
  if (view === "diff" && detail != null && !showDiffTab && (detail.cwd == null || diffSnapshots !== undefined)) {
    return <Navigate to={`/runs/${id}/conversation`} replace />;
  }

  if (!id) {
    return (
      <EmptyState
        data-testid="detail-missing-id"
        title="Missing run id"
        description="The URL didn't include a run identifier."
        action={
          <Link to="/runs" className="text-xs text-sw-muted hover:text-sw-text hover:underline">
            ← all runs
          </Link>
        }
      />
    );
  }

  return (
    <section className="flex h-full w-full min-w-0 flex-col gap-4">
      <DetailHeader
        detail={detail ?? null}
        id={id}
        isLive={isLive}
        isReconnecting={isReconnecting}
        liveCost={liveCost}
        runId={id}
      />

      {(detail?.runStatus === "paused" || detail?.runStatus === "paused_auto") && (
        <RunPausedNotice runId={id} eventEpoch={totalEvents} imported={detail.imported} />
      )}
      {detail?.runStatus === "halted" && (
        <RunHaltedNotice
          haltReason={detail.haltReason}
          haltDetail={detail.haltDetail}
          haltContext={detail.haltContext}
        />
      )}
      {detail?.crashRequeues != null && detail.crashRequeues.length > 0 && (
        <CrashRequeueNotice crashRequeues={detail.crashRequeues} />
      )}
      {isError && !detail ? (
        error instanceof ApiError && error.status === 404 ? (
          <EmptyState
            data-testid="detail-not-found"
            title="Run not found"
            description="No run with this id exists in this store — the link may be stale or point at a different store."
            action={
              <Link to="/runs" className="text-xs text-sw-muted hover:text-sw-text hover:underline">
                ← all runs
              </Link>
            }
          />
        ) : (
          <EmptyState
            data-testid="detail-error"
            title="Couldn't load this run"
            description="The server returned an error — reload the page to retry."
            action={
              <Link to="/runs" className="text-xs text-sw-muted hover:text-sw-text hover:underline">
                ← all runs
              </Link>
            }
          />
        )
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
            {showDiffTab && (
              <TabsTrigger value="diff" data-testid="view-tab-diff">
                Diff
              </TabsTrigger>
            )}
          </TabsList>

          <div
            data-testid={`${view}-region`}
            className="min-h-0 min-w-0 flex-1 overflow-auto rounded-md border bg-sw-bg"
          >
            <TabsContent value="conversation" className="h-full">
              <RunConversation
                messages={messages}
                messagesError={messagesError}
                streamingByNode={streamingByNode}
                toolStreams={toolStreams}
                nodeStates={detail?.nodes}
                isLive={isLive}
                isPaused={detail?.status === "paused"}
                isLoading={isLoading}
                {...(detail?.fanout ? { fanout: detail.fanout } : {})}
                hitl={
                  detail?.runStatus === "paused_human" && detail.hitlNodeId
                    ? {
                        runId: id,
                        nodeId: detail.hitlNodeId,
                        label: detail.hitlLabel ?? null,
                        options: detail.hitlOptions ?? [],
                        ...(detail.hitlOptionLabels ? { optionLabels: detail.hitlOptionLabels } : {}),
                      }
                    : null
                }
                hitlDecisions={detail?.hitlDecisions ?? null}
              />
            </TabsContent>
            <TabsContent value="graph" className="h-full">
              <RunGraphTab
                detail={detail ?? null}
                selectedNodeId={selectedNodeId}
                onSelect={handleNodeClick}
                onDeselect={handleDeselect}
                activeNodeIds={activeNodeIds}
              />
            </TabsContent>
            <TabsContent value="cost" className="h-full">
              <CostInspector
                runId={id}
                totalEvents={totalEvents}
                isLive={isLive}
                {...(detail?.fanout ? { fanout: detail.fanout } : {})}
              />
            </TabsContent>
            {showDiffTab && (
              <TabsContent value="diff" className="h-full">
                <RunDiffTab runId={id} run={detail ?? undefined} />
              </TabsContent>
            )}
          </div>

          {view === "conversation" && detail?.status === "running" && <SteerInput runId={id} messages={messages} />}
        </Tabs>
      )}
    </section>
  );
}

// ─── Header: run-level title + stats strip ────────────────────────
//
// Memoised: useRunLive's `setStreaming` fires once per llm.*_delta,
// so on a typical run RunDetail re-renders ~1700 times. Without memo
// the header subtree (badges, NumberFlow tiles in StatsStrip) would
// recompute on every one despite none of its props moving. Shallow
// comparison is correct here — `detail` is from useMemo, `liveCost`
// is from useState, `id`/`isLive` are primitives.

const DetailHeader = memo(function DetailHeader({
  detail,
  id,
  isLive,
  isReconnecting,
  liveCost,
  runId,
}: {
  detail: RunDetailT | null;
  id: string;
  isLive: boolean;
  isReconnecting: boolean;
  liveCost: CostAggregate;
  runId: string;
}): JSX.Element {
  const showLive = isLive && detail?.status === "running";
  const showReconnecting = !showLive && isReconnecting && detail?.status === "running";
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
  // Highest iteration touched by any node fact. > 0 means the run actually
  // looped (backward edge or goal-gate retarget); surface it so the user
  // knows the graph view's per-node state collapses iterations.
  const maxIteration = nodes.reduce((m, n) => (n.iteration > m ? n.iteration : m), 0);
  return (
    <header className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-baseline gap-2">
        <Link to="/runs" className="text-xs text-sw-muted hover:text-sw-text hover:underline">
          ← all runs
        </Link>
        {detail?.workflowName && detail?.workflow && (
          <>
            <span className="text-xs text-sw-muted/40">·</span>
            <WorkflowLink name={detail.workflow} label={detail.workflowName} variant="text" title={detail.workflow} />
          </>
        )}
        {detail?.projectId && (
          <>
            <span className="text-xs text-sw-muted/40">·</span>
            <ProjectLink
              projectId={detail.projectId}
              name={detail.projectName}
              variant="text"
              title={detail.cwd ?? detail.projectName}
              data-testid="detail-project-link"
            >
              {detail.projectName ?? (detail.cwd ? projectBasename(detail.cwd) : detail.projectId)}
            </ProjectLink>
          </>
        )}
        {(detail?.baseGitRef ?? detail?.baseGitSha) && (
          <>
            <span className="text-xs text-sw-muted/40">·</span>
            <span
              data-testid="detail-base-ref"
              className="font-mono text-xs text-sw-muted"
              title={detail?.baseGitSha ?? undefined}
            >
              {detail?.baseGitRef ?? ""}
              {detail?.baseGitSha ? ` ${detail.baseGitSha.slice(0, 7)}` : ""}
            </span>
          </>
        )}
        {showLive && (
          <>
            <span className="text-xs text-sw-muted/40">·</span>
            <span
              data-testid="detail-live-pill"
              className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-sw-accent-thinking"
            >
              <span className="sw-pulse inline-block size-1.5 rounded-full bg-sw-accent-thinking ring-2 ring-sw-accent-thinking/30" />
              live
            </span>
          </>
        )}
        {showReconnecting && (
          <>
            <span className="text-xs text-sw-muted/40">·</span>
            <span
              data-testid="detail-reconnecting-pill"
              title="Live updates interrupted — reconnecting to the event stream"
              className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-sw-accent-warn"
            >
              <span className="sw-pulse inline-block size-1.5 rounded-full bg-sw-accent-warn ring-2 ring-sw-accent-warn/30" />
              reconnecting…
            </span>
          </>
        )}
      </div>
      <div className="min-w-0">
        <h2 className="truncate text-lg font-semibold" title={detail ? headingTitle(detail) : id}>
          {detail ? headingText(detail) : shortenRunId(id)}
        </h2>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-mono text-xs text-sw-muted" title={id}>
            {shortenRunId(id)}
          </span>
          {detail && (
            <RunStatusBadge
              status={detail.status}
              runStatus={detail.runStatus}
              data-testid="detail-status"
              className="px-1.5 py-0.5 text-[0.65rem]"
            />
          )}
          {detail?.imported && (
            <ImportedBadge className="px-1.5 py-0.5 text-[0.65rem]" data-testid="detail-imported-badge" />
          )}
          {detail && currentLabel && (
            <span
              data-testid="detail-current-node-inline"
              className="shrink-0 max-w-[16rem] truncate rounded border border-sw-border bg-sw-surface px-1.5 py-0.5 font-mono text-[0.65rem] text-sw-muted"
              title={currentLabel}
            >
              {currentLabel}
            </span>
          )}
          {detail && maxIteration > 0 && (
            <span
              data-testid="detail-loops-pill"
              className="shrink-0 rounded border border-sw-border bg-sw-surface px-1.5 py-0.5 font-mono text-[0.65rem] text-sw-muted"
              title={`At least one node re-entered — ${maxIteration + 1} iterations seen`}
            >
              loops {maxIteration + 1}×
            </span>
          )}
          {detail && (
            <div className="ml-auto">
              <RunControls
                runId={runId}
                status={detail.status}
                runStatus={detail.runStatus}
                hitlOptionsCount={detail.hitlOptions?.length ?? 0}
                compact
                imported={detail.imported}
              />
            </div>
          )}
        </div>
      </div>
      <StatsStrip detail={detail} liveCost={liveCost} />
    </header>
  );
});

// `useNow` inside StatsStrip ticks 1Hz on live runs and re-renders
// internally regardless of memo, but cutting off streaming-delta-
// driven parent re-renders here saves the NumberFlow render pass
// when only `streaming` moved in the parent.
export const StatsStrip = memo(function StatsStrip({
  detail,
  liveCost,
}: {
  detail: RunDetailT | null;
  liveCost?: CostAggregate;
}): JSX.Element {
  const loading = detail == null;
  const isLiveRun = detail != null && LIVE_STATUSES.has(detail.status);
  const now = useNow(1_000, isLiveRun);
  const durationMs = isLiveRun ? Math.max(0, now - Date.parse(detail.startedAt)) : detail?.durationMs;

  // The snapshot covers events ≤ snapshot.lastEventSeq; useRunLive opens
  // SSE at sinceSeq=snapshot.lastEventSeq so liveCost only accumulates
  // events strictly past that cursor.
  const liveCostUsd = liveCost?.totalCostUsd ?? 0;
  const liveInputTokens = liveCost?.totalInputTokens ?? 0;
  const liveOutputTokens = liveCost?.totalOutputTokens ?? 0;
  const liveCacheReadTokens = liveCost?.totalCacheReadTokens ?? 0;
  const liveCacheWriteTokens = liveCost?.totalCacheWriteTokens ?? 0;
  const costUsd = (detail?.costUsd ?? 0) + liveCostUsd;
  const inputTokens = (detail?.inputTokens ?? 0) + liveInputTokens;
  const outputTokens = (detail?.outputTokens ?? 0) + liveOutputTokens;
  const cacheReadTokens: number | undefined =
    detail?.cacheReadTokens === undefined ? undefined : detail.cacheReadTokens + liveCacheReadTokens;
  const cacheWriteTokens: number | undefined =
    detail?.cacheWriteTokens === undefined ? undefined : detail.cacheWriteTokens + liveCacheWriteTokens;
  const billedTokens = inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  // Denominator includes cacheWrite — see lib/format.ts formatCacheHitRate.
  // A warm thread otherwise reads as ~100% on a single-turn re-dispatch.
  const cacheHitDenom = inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  const cacheHitRate: number | undefined =
    cacheReadTokens !== undefined && cacheHitDenom > 0 ? cacheReadTokens / cacheHitDenom : undefined;

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
        numericValue={billedTokens}
        format={tokensCompactFormatOptions(billedTokens)}
        testId="detail-tokens-tile"
        icon={<Coins className="size-4" />}
        hint={
          detail
            ? `input ${inputTokens.toLocaleString()} · output ${outputTokens.toLocaleString()} · cache read ${(cacheReadTokens ?? 0).toLocaleString()} · cache write ${(cacheWriteTokens ?? 0).toLocaleString()}`
            : undefined
        }
      />
      <StatTile
        label="Cache"
        loading={loading}
        numericValue={cacheHitRate}
        format={percentFormatOptions()}
        testId="detail-cache-tile"
        icon={<Database className="size-4" />}
        hint={
          detail
            ? `cache read ${(cacheReadTokens ?? 0).toLocaleString()} · input ${inputTokens.toLocaleString()}`
            : undefined
        }
      />
    </div>
  );
});

// ─── Graph tab ────────────────────────────────────────────────────
//
// Graph spans the full tab width; clicking a node opens a right-side
// `Sheet` drawer containing `NodeInspector`. Radix `TabsContent`
// already lazy-mounts non-active tabs, so this only renders when the
// user is on the graph view. Memoising still pays off there:
// streaming-delta-driven parent re-renders skip the graph subtree
// entirely (its props don't depend on `streaming` / `messages`).

// Same drawer cadence as `WorkflowDetail` / `DrillDownDrawer` — see
// the comment over `DRAWER_MOTION` there for the rationale.
const DRAWER_MOTION = cn(
  "data-open:[animation-duration:280ms] data-open:[animation-timing-function:cubic-bezier(0.32,0.72,0,1)]",
  "data-closed:[animation-duration:220ms] data-closed:[animation-timing-function:cubic-bezier(0.32,0.72,0,1)]",
  "motion-reduce:data-open:[animation-duration:1ms] motion-reduce:data-closed:[animation-duration:1ms]",
);

const RunGraphTab = memo(function RunGraphTab({
  detail,
  selectedNodeId,
  onSelect,
  onDeselect,
  activeNodeIds,
}: {
  detail: RunDetailT | null;
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
  onDeselect: () => void;
  activeNodeIds?: ReadonlySet<string>;
}): JSX.Element {
  const graph = useMemo(() => {
    if (!detail?.workflowSource) return null;
    try {
      return parseWorkflow(detail.workflowSource);
    } catch {
      return null;
    }
  }, [detail?.workflowSource]);

  const activeNodeId = detail?.nodes.find((n) => n.state === "running")?.nodeId ?? null;
  const hitlNodeId = detail?.runStatus === "paused_human" ? (detail.hitlNodeId ?? null) : null;
  // Pass the active-node Set through so every running node glows.
  const effectiveActiveNodeIds = activeNodeIds ?? (activeNodeId ? new Set([activeNodeId]) : undefined);
  const selected = selectedNodeId && graph ? (graph.nodes[selectedNodeId] ?? null) : null;
  const selectedState = selectedNodeId ? (detail?.nodes.find((n) => n.nodeId === selectedNodeId) ?? null) : null;

  return (
    <>
      <div className="h-full min-h-[480px] min-w-0 p-2">
        {detail ? (
          <GraphView
            detail={detail}
            orientation="TB"
            activeNodeId={activeNodeId}
            activeNodeIds={effectiveActiveNodeIds}
            selectedNodeId={selectedNodeId}
            hitlNodeId={hitlNodeId}
            onNodeClick={onSelect}
          />
        ) : null}
      </div>
      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) onDeselect();
        }}
      >
        <SheetContent side="right" className={cn("flex w-full flex-col gap-0 p-0 sm:max-w-md", DRAWER_MOTION)}>
          {selected ? (
            <>
              <SheetHeader className="border-b border-sw-border px-4 py-3">
                <SheetTitle className="truncate text-sw-md font-medium text-sw-text">
                  {selected.attrs.label ?? selected.id}
                </SheetTitle>
                <SheetDescription className="text-sw-xs text-sw-muted">Node configuration</SheetDescription>
              </SheetHeader>
              <NodeInspector
                node={selected}
                state={selectedState}
                className="min-h-0 flex-1 rounded-none border-0 bg-transparent"
              />
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
});

// ─── Helpers ──────────────────────────────────────────────────────

const shortenRunId = shortRunId;

function headingText(detail: RunDetailT): string {
  if (detail.title && detail.title.length > 0) return detail.title;
  return detail.workflowName ?? shortenRunId(detail.runId);
}

function headingTitle(detail: RunDetailT): string {
  if (detail.title && detail.title.length > 0) return detail.title;
  return detail.workflowName ?? detail.runId;
}

function projectBasename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}
