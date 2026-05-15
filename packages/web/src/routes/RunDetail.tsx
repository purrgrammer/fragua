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

import { useQuery } from "@tanstack/react-query";
import { Coins, Database, DollarSign, Timer } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CodeBlock } from "../components/ai-elements/code-block.tsx";
import {
  Commit,
  CommitFile,
  CommitFileAdditions,
  CommitFileChanges,
  CommitFileDeletions,
  CommitFileIcon,
  CommitFileInfo,
  CommitFilePath,
  CommitFileStatus,
  CommitFiles,
} from "../components/ai-elements/commit.tsx";
import { FileTree } from "../components/ai-elements/file-tree.tsx";
import { CostInspector } from "../components/CostInspector.tsx";
import { GraphView } from "../components/GraphView.tsx";
import { HitlChoice } from "../components/HitlChoice.tsx";
import { NodeInspector } from "../components/NodeInspector.tsx";
import { ProjectLink } from "../components/ProjectLink.tsx";
import { RunControls } from "../components/RunControls.tsx";
import { RunConversation } from "../components/RunConversation.tsx";
import { RunPausedNotice } from "../components/RunPausedNotice.tsx";
import { RunStatusBadge } from "../components/RunStatusBadge.tsx";
import SteerInput from "../components/SteerInput.tsx";
import { SubRunList } from "../components/SubRunList.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet.tsx";
import { StatTile } from "../components/ui/stat-tile.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import { WorkflowLink } from "../components/WorkflowLink.tsx";
import type { RunChange, RunDetail as RunDetailT } from "../lib/api.ts";
import { ApiError } from "../lib/api.ts";
import { useBranchMeta } from "../lib/branch-meta.ts";
import { cn } from "../lib/cn.ts";
import { buildTree, extToLang, TreeNodeView } from "../lib/file-tree.tsx";
import { percentFormatOptions, tokensCompactFormatOptions, usdFormatOptions } from "../lib/format.ts";
import { parseAndPrepare } from "../lib/parse-workflow.ts";
import { queries } from "../lib/queries.ts";
import { shortRunId } from "../lib/runId.ts";
import { formatDateTime, formatDuration, formatRelative } from "../lib/time.ts";
import { mergeDetail } from "../lib/useDetailOverlay.ts";
import type { CostAggregate } from "../lib/useLiveCostAggregate.ts";
import { useNow } from "../lib/useNow.ts";
import { useRunLive } from "../lib/useRunLive.ts";

const VIEWS = ["conversation", "graph", "cost", "files"] as const;
type TabId = (typeof VIEWS)[number];

/** Statuses where the run is still progressing and the clock should tick.
 * `paused` is excluded — a paused run isn't doing work, so the duration
 * tile should freeze at the moment of the pause fact (the snapshot's
 * `durationMs` already reflects `lastEvent - firstEvent`). */
const LIVE_STATUSES = new Set<string>(["queued", "running"]);

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
  const [searchParams] = useSearchParams();

  const view: TabId = isTabId(rawView) ? rawView : "conversation";
  const shouldCanonicalize = !!id && rawView !== view;

  // All hooks before any conditional return — Rules of Hooks.
  // Snapshot is fetched ONCE at mount and never refetched: SSE events
  // are folded into `detailOverlay` and merged in-memory via
  // `mergeDetail` for display. Previously this effect re-fired
  // `qc.refetchQueries(detail)` on every SSE frame — on a 1k-events/sec
  // run that was a thousand full-payload refetches per second.
  const { data: snapshot, isError } = useQuery({ ...queries.runs.detail(id), enabled: !!id });

  // P6 of the sub-runs UI plan: a child run is an implementation
  // detail of its parent. If someone navigates directly to a child id
  // (deep link, scripted curl, old bookmark), redirect to the parent
  // with the branch anchor so the operator lands on the right
  // surface. `?orphan=true` is an escape hatch for debugging.
  const orphan = searchParams.get("orphan") === "true";
  const isChildRun = snapshot?.parentRunId != null && snapshot.parentRunId.length > 0 && !orphan;
  const childRedirectTo = isChildRun
    ? `/runs/${snapshot.parentRunId}/${view}${
        snapshot.branchNodeId != null && snapshot.branchNodeId.length > 0
          ? `?branch=${encodeURIComponent(snapshot.branchNodeId)}`
          : ""
      }`
    : null;
  // Tri-state: `undefined` while the snapshot is loading; `true` only
  // when we've confirmed a terminal status. `useRunLive` defers opening
  // SSE until this lands as a boolean so we don't flash a transient
  // connection during the snapshot's first ~50ms.
  const isTerminal: boolean | undefined = snapshot == null ? undefined : TERMINAL_STATUSES.has(snapshot.status);
  const {
    messages,
    streaming,
    toolStreams,
    status: liveStatus,
    totalEvents,
    liveCost,
    detailOverlay,
    subagentByToolCallId,
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

  // Branch metadata for parallel fan-outs. Empty maps for runs without
  // parallel sections — consumers no-op.
  const branchMeta = useBranchMeta(id || null, detail, totalEvents);
  const activeNodeIds = useMemo<ReadonlySet<string>>(() => {
    // Union the parent's own running nodes with each non-terminal
    // descendant's current_node (P3 / P7 of the sub-runs UI plan).
    // Without the descendant nodes, the graph stays frozen on
    // `parallel.*` while the lenses are actually running inside child
    // runs.
    const out = new Set<string>(
      (detail?.nodes ?? []).filter((n) => n.state === "running").map((n) => n.nodeId),
    );
    for (const active of detail?.effectiveActiveNodes ?? []) {
      out.add(active.nodeId);
    }
    return out;
  }, [detail?.nodes, detail?.effectiveActiveNodes]);

  // `isLive` here means "actively dispatching", not just "SSE connected".
  // A paused run keeps the SSE socket open (so resume facts still arrive)
  // but isn't producing tokens, so streaming labels / pulses must stop.
  // Reads the overlay-merged status so the badge flips the moment a
  // pause / resume / cancel fact lands, without waiting for a refetch.
  const isLive = (liveStatus === "live" || liveStatus === "loading") && detail?.status === "running";

  const handleNodeClick = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    document.getElementById(`node-${nodeId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  const handleDeselect = useCallback(() => setSelectedNodeId(null), []);

  // Canonicalize the URL: bare /runs/:id → /runs/:id/conversation,
  // invalid view → same. Runs AFTER all hooks to stay rules-compliant.
  if (shouldCanonicalize) return <Navigate to={`/runs/${id}/${view}`} replace />;

  // P6: redirect direct child-run URLs to the parent. Runs after the
  // snapshot lands so we can read `parentRunId` / `branchNodeId`.
  if (childRedirectTo != null) return <Navigate to={childRedirectTo} replace />;

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
      <DetailHeader detail={detail ?? null} id={id} isLive={isLive} liveCost={liveCost} runId={id} />

      {(detail?.runStatus === "paused" || detail?.runStatus === "paused_auto") && <RunPausedNotice runId={id} />}
      {detail?.runStatus === "paused_hitl" && (
        <HitlChoice runId={id} label={detail.hitlLabel} options={detail.hitlOptions ?? []} />
      )}

      {/* P5 of docs/proposals/parallel.md: render the parent's
          sub-runs (parallel branches) above the tabs. Self-renders
          nothing when the run has no children. */}
      {id != null && id.length > 0 && <SubRunList parentRunId={id} />}

      {isError && !detail ? (
        <EmptyState
          data-testid="detail-error"
          title="Couldn't load this run"
          description="The server didn't return details for this run."
          action={
            <Link to="/runs" className="text-xs text-sw-muted hover:text-sw-text hover:underline">
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
            <TabsTrigger value="files" data-testid="view-tab-files">
              Files
            </TabsTrigger>
          </TabsList>

          <div
            data-testid={`${view}-region`}
            className="min-h-0 min-w-0 flex-1 overflow-auto rounded-md border bg-sw-bg"
          >
            <TabsContent value="conversation" className="h-full">
              <RunConversation
                messages={messages}
                streaming={streaming}
                toolStreams={toolStreams}
                nodeStates={detail?.nodes}
                isLive={isLive}
                isPaused={detail?.status === "paused"}
                isLoading={isLoading}
                userInput={detail?.input ?? null}
                branchesByParent={branchMeta.parentToBranches}
                fanInResultsByParent={branchMeta.fanInResultsByParent}
                subagentByToolCallId={subagentByToolCallId}
              />
            </TabsContent>
            <TabsContent value="graph" className="h-full">
              <RunGraphTab
                detail={detail ?? null}
                selectedNodeId={selectedNodeId}
                onSelect={handleNodeClick}
                onDeselect={handleDeselect}
                activeNodeIds={activeNodeIds}
                winnerBranchIds={branchMeta.winnerBranchIds}
              />
            </TabsContent>
            <TabsContent value="cost" className="h-full">
              <CostInspector runId={id} totalEvents={totalEvents} isLive={isLive} />
            </TabsContent>
            <TabsContent value="files" className="h-full">
              <RunFilesTab runId={id} />
            </TabsContent>
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
  liveCost,
  runId,
}: {
  detail: RunDetailT | null;
  id: string;
  isLive: boolean;
  liveCost: CostAggregate;
  runId: string;
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
        {detail?.cwd && (
          <>
            <span className="text-xs text-sw-muted/40">·</span>
            <ProjectLink cwd={detail.cwd} variant="text" title={detail.cwd} data-testid="detail-project-link">
              {projectBasename(detail.cwd)}
            </ProjectLink>
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
  // events strictly past that cursor. The two are disjoint by
  // construction (the server unions ?sinceSeq= and Last-Event-ID via
  // max()), so summing them gives the run's live total at all times.
  // The earlier swap shape collapsed the displayed cost from "snapshot
  // total" to "post-snapshot delta only" the moment any cost.recorded
  // event landed — which made near-terminal runs read out the trailing
  // batch alone after `fact.run_completed` flipped the status overlay.
  const liveCostUsd = liveCost?.totalCostUsd ?? 0;
  const liveInputTokens = liveCost?.totalInputTokens ?? 0;
  const liveOutputTokens = liveCost?.totalOutputTokens ?? 0;
  const liveCacheReadTokens = liveCost?.totalCacheReadTokens ?? 0;
  const liveCacheWriteTokens = liveCost?.totalCacheWriteTokens ?? 0;
  const costUsd = (detail?.costUsd ?? 0) + liveCostUsd;
  const inputTokens = (detail?.inputTokens ?? 0) + liveInputTokens;
  const outputTokens = (detail?.outputTokens ?? 0) + liveOutputTokens;
  // Preserve undefined while the snapshot itself hasn't loaded — the
  // AnimatedNumber fallback ("—") is the right loading sentinel. A
  // loaded snapshot post-rename always carries a number for cacheReadTokens.
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
  winnerBranchIds,
}: {
  detail: RunDetailT | null;
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
  onDeselect: () => void;
  activeNodeIds?: ReadonlySet<string>;
  winnerBranchIds?: ReadonlySet<string>;
}): JSX.Element {
  const graph = useMemo(() => {
    if (!detail?.workflowSource) return null;
    try {
      return parseAndPrepare(detail.workflowSource);
    } catch {
      return null;
    }
  }, [detail?.workflowSource]);

  const activeNodeId = detail?.nodes.find((n) => n.state === "running")?.nodeId ?? null;
  const hitlNodeId = detail?.runStatus === "paused_hitl" ? (detail.hitlNodeId ?? null) : null;
  // Pass the multi-active-node Set through so parallel branches that
  // are running (alongside their parent component) all glow.
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
            winnerBranchIds={winnerBranchIds}
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

function projectBasename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

// ─── Files tab ─────────────────────────────────────────────────────────
//
// Two stacked panes:
//
//   1. <Commit> block — one row per RunChange. Driven by
//      `GET /runs/:id/changes`, which folds `git diff --numstat` +
//      `--name-status` between `baseGitSha` and the
//      `swarm/runs/<id>` ref. Survives worktree disposal because the
//      branch ref is preserved in the project repo.
//   2. FileTree + CodeBlock — driven by `GET /runs/:id/tree` /
//      `/blob`. Both 410 once the worktree is disposed; in that case
//      we hide this pane entirely and the Commit block stands alone.
//
// Selecting a file (either by clicking a row in the Commit list or a
// node in the FileTree) writes `?path=` to the URL so the selection is
// shareable.

function RunFilesTab({ runId }: { runId: string }): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedPath = searchParams.get("path") ?? "";

  const changesQuery = useQuery(queries.runs.changes(runId));
  const treeQuery = useQuery(queries.runs.tree(runId));
  const blobQuery = useQuery(queries.runs.blob(runId, selectedPath));
  const diffQuery = useQuery(queries.runs.diff(runId));

  const treeRoot = useMemo(() => buildTree(treeQuery.data ?? []), [treeQuery.data]);
  const treeUnavailable = treeQuery.error instanceof ApiError && treeQuery.error.status === 410;

  const handleSelect = useCallback(
    (path: string): void => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (path === selectedPath) next.delete("path");
          else next.set("path", path);
          return next;
        },
        { replace: true },
      );
    },
    [selectedPath, setSearchParams],
  );

  const changes = changesQuery.data ?? [];

  return (
    <section className="flex h-full min-h-0 w-full min-w-0 flex-col gap-4 p-3" data-testid="run-files-section">
      {changes.length > 0 ? (
        <Commit defaultOpen data-testid="run-files-commit">
          <CommitFiles>
            {changes.map((c) => (
              <CommitRow key={c.path} change={c} selected={c.path === selectedPath} onSelect={handleSelect} />
            ))}
          </CommitFiles>
        </Commit>
      ) : changesQuery.isPending ? (
        <div className="text-sw-sm text-sw-muted">Loading changes…</div>
      ) : (
        <div className="text-sw-sm text-sw-muted" data-testid="run-files-no-changes">
          No tracked changes yet.
        </div>
      )}

      {treeUnavailable ? (
        <div
          className="rounded-md border border-sw-border bg-sw-surface p-3 text-sw-sm text-sw-muted"
          data-testid="run-files-disposed"
        >
          Worktree disposed; full diff and changes below. Read from the preserved{" "}
          <code className="font-mono">swarm/runs/{runId}</code> branch.
        </div>
      ) : (
        <div className="grid min-h-0 grid-cols-1 gap-3 md:grid-cols-[18rem_1fr]">
          <div className="max-h-[28rem] min-h-0 overflow-y-auto" data-testid="run-files-tree">
            {treeQuery.isPending ? (
              <div className="p-2 text-sw-sm text-sw-muted">Loading…</div>
            ) : treeQuery.data && treeQuery.data.length > 0 ? (
              <FileTree selectedPath={selectedPath} onSelect={handleSelect}>
                {treeRoot.children.map((child) => (
                  <TreeNodeView key={child.path} node={child} />
                ))}
              </FileTree>
            ) : (
              <div className="p-2 text-sw-sm text-sw-muted">Worktree is empty.</div>
            )}
          </div>
          <div className="min-w-0 overflow-hidden rounded-lg border bg-sw-surface" data-testid="run-files-viewer">
            {selectedPath.length === 0 ? (
              <div className="p-4 text-sw-sm text-sw-muted">Select a file to preview.</div>
            ) : blobQuery.error ? (
              <RunBlobError error={blobQuery.error} path={selectedPath} />
            ) : blobQuery.isFetching ? (
              <div className="p-4 text-sw-sm text-sw-muted">Loading…</div>
            ) : blobQuery.data !== undefined ? (
              <CodeBlock code={blobQuery.data} language={extToLang(selectedPath)} showLineNumbers />
            ) : (
              <div className="p-4 text-sw-sm text-sw-muted">No content.</div>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2" data-testid="run-files-diff">
        <div className="text-sw-sm font-medium text-sw-foreground">Full diff</div>
        {diffQuery.isPending ? (
          <div className="text-sw-sm text-sw-muted">Loading diff…</div>
        ) : diffQuery.error instanceof ApiError && diffQuery.error.status === 410 ? (
          <div
            className="rounded-md border border-sw-border bg-sw-surface p-3 text-sw-sm text-sw-muted"
            data-testid="run-files-diff-unavailable"
          >
            Diff unavailable — base or branch missing.
          </div>
        ) : diffQuery.data === "" ? (
          <div className="text-sw-sm text-sw-muted" data-testid="run-files-diff-empty">
            No changes vs base
          </div>
        ) : diffQuery.data !== undefined ? (
          <div className="min-w-0 overflow-hidden rounded-lg border bg-sw-surface">
            <CodeBlock code={diffQuery.data} language="diff" />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function CommitRow({
  change,
  selected,
  onSelect,
}: {
  change: RunChange;
  selected: boolean;
  onSelect: (path: string) => void;
}): JSX.Element {
  return (
    // biome-ignore lint/a11y/useSemanticElements: CommitFile renders a <div> from ai-elements; role+tabIndex give it button semantics without a wrapping <button> that would break the existing styling.
    <CommitFile
      role="button"
      tabIndex={0}
      data-testid={`run-files-commit-row-${change.path}`}
      data-selected={selected ? "true" : undefined}
      className={cn("cursor-pointer", selected && "bg-sw-surface ring-1 ring-sw-border")}
      onClick={() => onSelect(change.path)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(change.path);
        }
      }}
    >
      <CommitFileInfo>
        <CommitFileStatus status={change.status} />
        <CommitFileIcon />
        <CommitFilePath title={change.path}>{change.path}</CommitFilePath>
      </CommitFileInfo>
      <CommitFileChanges>
        <CommitFileAdditions count={change.additions} />
        <CommitFileDeletions count={change.deletions} />
      </CommitFileChanges>
    </CommitFile>
  );
}

function RunBlobError({ error, path }: { error: unknown; path: string }): JSX.Element {
  const status = error instanceof ApiError ? error.status : 0;
  let msg: string;
  if (status === 413) msg = "File too large to preview (>1 MB).";
  else if (status === 415) msg = "Binary file — not previewable.";
  else if (status === 404) msg = "File not found.";
  else if (status === 410) msg = "Worktree disposed.";
  else msg = `Couldn't load ${path}.`;
  return <div className="p-4 text-sw-sm text-sw-muted">{msg}</div>;
}
