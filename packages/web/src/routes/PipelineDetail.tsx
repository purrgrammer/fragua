// GET /pipelines/:id → detail page.
//
// Post-P5.08 layout is minimal by design: a header with run identity +
// metrics, and a single primary surface — `<PipelineConversation />` —
// that streams the run as an AI-Elements-based conversation. The graph
// "map" panel and the timeline placeholder have been removed; the
// conversation is the main view, period.
//
// Data flow:
//   - `useRunConversation(id)` owns the event pipeline end-to-end: a
//     REST bootstrap fetches the full history, then SSE delivers new
//     events. Events are folded into the conversation tree via
//     `applyEvent` on arrival; the client never keeps a raw-event
//     buffer, so memory scales with conversation content (KB) rather
//     than event count (MB on a 23K-event run).
//   - `queries.pipelines.detail(id)` drives the header metrics. We
//     invalidate on `totalEvents` changes so cost / tokens / duration
//     stay live.

import { parseDotSource } from "@swarm/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { GraphView } from "../components/GraphView.tsx";
import { NodeInspector } from "../components/NodeInspector.tsx";
import { PipelineConversation } from "../components/PipelineConversation.tsx";
import SteerInput from "../components/SteerInput.tsx";
import { StepInspector } from "../components/StepInspector.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import type { PipelineDetail as PipelineDetailT } from "../lib/api.ts";
import { formatTokensCompact, formatTokensLong, formatUsd, statusLabel } from "../lib/format.ts";
import { queries } from "../lib/queries.ts";
import { formatDateTime, formatDuration, formatRelative, toIsoTitle } from "../lib/time.ts";
import { useRunConversation } from "../lib/useRunConversation.ts";

export function PipelineDetail(): JSX.Element {
  const { id = "" } = useParams();
  const [view, setView] = useState<"conversation" | "steps" | "graph">("conversation");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const { conversation, status: convStatus, totalEvents, controlEvents } = useRunConversation(id || null);
  const isLoading = convStatus === "loading";

  const qc = useQueryClient();
  const { data: detail, isError } = useQuery({ ...queries.pipelines.detail(id), enabled: !!id });

  // Invalidate detail on totalEvents transitions so header metrics stay
  // live with the conversation stream. Cheap — server replays from disk.
  // biome-ignore lint/correctness/useExhaustiveDependencies: totalEvents is the intentional trigger; qc and id are stable.
  useEffect(() => {
    if (id) void qc.invalidateQueries({ queryKey: queries.pipelines.detail(id).queryKey });
  }, [totalEvents]);

  if (!id) {
    return (
      <EmptyState
        data-testid="detail-missing-id"
        title="Missing pipeline id"
        description="The URL didn't include a run identifier."
        action={
          <Link to="/" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
            ← all pipelines
          </Link>
        }
      />
    );
  }

  const isLive = convStatus === "live" || convStatus === "loading";

  return (
    <section className="flex h-full w-full min-w-0 flex-col gap-4">
      <header className="flex min-w-0 items-baseline justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link to="/" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
            ← all pipelines
          </Link>
          <h2
            className="mt-1 truncate text-lg font-semibold"
            title={detail && hasTitleOrInput(detail) ? headingTooltip(detail) : id}
          >
            {detail ? headingText(detail) : shortenRunId(id)}
          </h2>
          {detail && (detail.title || detail.input) && (
            <p className="mt-0.5 truncate font-mono text-xs text-slate-500" title={id}>
              {shortenRunId(id)}
            </p>
          )}
          {detail && <DetailMetaLine detail={detail} />}
        </div>
      </header>

      {isError && !detail && (
        <EmptyState
          data-testid="detail-error"
          title="Couldn't load this run"
          description="The server didn't return details for this run. It may have been deleted or the request failed — check the console for specifics."
          action={
            <Link to="/" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
              ← all pipelines
            </Link>
          }
        />
      )}

      {!(isError && !detail) && (
        <>
          <div role="tablist" aria-label="Detail view" className="flex gap-2 text-xs">
            <button
              type="button"
              role="tab"
              aria-selected={view === "conversation"}
              data-testid="view-tab-conversation"
              onClick={() => setView("conversation")}
              className={`px-3 py-1 rounded-md border ${view === "conversation" ? "bg-muted" : "bg-transparent"}`}
            >
              Conversation
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "graph"}
              data-testid="view-tab-graph"
              onClick={() => setView("graph")}
              className={`px-3 py-1 rounded-md border ${view === "graph" ? "bg-muted" : "bg-transparent"}`}
            >
              Graph
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "steps"}
              data-testid="view-tab-steps"
              onClick={() => setView("steps")}
              className={`px-3 py-1 rounded-md border ${view === "steps" ? "bg-muted" : "bg-transparent"}`}
            >
              Steps
            </button>
          </div>
          <div
            data-testid={
              view === "conversation" ? "conversation-region" : view === "graph" ? "graph-region" : "steps-region"
            }
            className="min-h-0 min-w-0 flex-1 overflow-auto rounded-md border bg-background"
          >
            {view === "conversation" ? (
              <PipelineConversation
                conversation={conversation}
                nodeStates={detail?.nodes}
                isLive={isLive}
                isLoading={isLoading}
                userInput={detail?.input ?? null}
              />
            ) : view === "graph" ? (
              <PipelineGraphTab
                detail={detail ?? null}
                refetchKey={totalEvents}
                selectedNodeId={selectedNodeId}
                onSelect={setSelectedNodeId}
              />
            ) : (
              <StepInspector runId={id} totalEvents={totalEvents} />
            )}
          </div>
          {view === "conversation" && detail?.status === "running" && <SteerInput runId={id} events={controlEvents} />}
        </>
      )}
    </section>
  );
}

function DetailMetaLine({ detail }: { detail: PipelineDetailT }): JSX.Element {
  const totalTokens = detail.inputTokens + detail.outputTokens;
  const hasUsage = detail.costUsd > 0 || totalTokens > 0;
  const cacheRead = detail.cacheReadTokens ?? 0;
  const cacheWrite = detail.cacheWriteTokens ?? 0;
  const hasCache = cacheRead > 0 || cacheWrite > 0;
  // Cache hit rate approximation: providers that report cached tokens
  // exclude them from input_tokens, so summing the two reconstructs the
  // total prompt the model saw.
  const cacheDenom = detail.inputTokens + cacheRead;
  const cacheHitRate = cacheDenom > 0 ? cacheRead / cacheDenom : undefined;
  const workflowLabel = detail.workflowName ?? detail.workflow;

  return (
    <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-slate-600">
      <span>
        status: <span data-testid="detail-status">{statusLabel(detail.status)}</span>
      </span>
      <span>·</span>
      <span title={`duration ${formatDuration(detail.durationMs, { fallback: "unknown" })}`}>
        duration: <span data-testid="detail-duration">{formatDuration(detail.durationMs)}</span>
      </span>
      <span>·</span>
      <span title={toIsoTitle(detail.startedAt)}>
        started:{" "}
        <span data-testid="detail-started" title={formatDateTime(detail.startedAt)}>
          {formatRelative(detail.startedAt)}
        </span>
      </span>
      <span>·</span>
      <span>
        events: <span data-testid="detail-event-count">{detail.lastEventSeq}</span>
      </span>
      <span>·</span>
      <span
        data-testid="detail-usage"
        title={
          hasUsage
            ? `cost ${formatUsd(detail.costUsd)} · input ${formatTokensLong(
                detail.inputTokens,
              )} · output ${formatTokensLong(detail.outputTokens)} tokens`
            : "no LLM usage reported"
        }
      >
        {hasUsage ? (
          <>
            cost: <span data-testid="detail-cost">{formatUsd(detail.costUsd)}</span> · tokens:{" "}
            <span data-testid="detail-tokens">{formatTokensCompact(totalTokens)}</span>
          </>
        ) : (
          "cost: — · tokens: —"
        )}
      </span>
      {hasCache && (
        <>
          <span>·</span>
          <span
            data-testid="detail-cache"
            title={`cache ${formatTokensLong(cacheRead)} read · ${formatTokensLong(cacheWrite)} written${
              cacheHitRate !== undefined ? ` · hit rate ${(cacheHitRate * 100).toFixed(0)}%` : ""
            }`}
          >
            cache:{" "}
            <span data-testid="detail-cache-read">
              {formatTokensCompact(cacheRead)}
              {cacheHitRate !== undefined ? ` (${(cacheHitRate * 100).toFixed(0)}%)` : ""}
            </span>
          </span>
        </>
      )}
      {workflowLabel && (
        <>
          <span>·</span>
          <span className="max-w-[16rem] truncate" title={detail.workflow ?? ""}>
            workflow: {workflowLabel}
          </span>
        </>
      )}
    </p>
  );
}

const RUN_ID_SHORT_LEN = 8;

function shortenRunId(runId: string): string {
  return runId.length > RUN_ID_SHORT_LEN ? runId.slice(0, RUN_ID_SHORT_LEN) : runId;
}

function headingText(detail: PipelineDetailT): string {
  if (detail.title && detail.title.length > 0) return detail.title;
  if (detail.input && detail.input.length > 0) {
    const single = detail.input.replace(/\s+/g, " ").trim();
    return single.length > 80 ? `${single.slice(0, 79)}…` : single;
  }
  return shortenRunId(detail.runId);
}

function hasTitleOrInput(detail: PipelineDetailT): boolean {
  return Boolean((detail.title && detail.title.length > 0) || (detail.input && detail.input.length > 0));
}

function headingTooltip(detail: PipelineDetailT): string {
  const parts: string[] = [`run_id: ${detail.runId}`];
  if (detail.title) parts.push(`title: ${detail.title}`);
  if (detail.input) parts.push(`input: ${detail.input}`);
  const wf = detail.workflowName ?? detail.workflow;
  if (wf) parts.push(`workflow: ${wf}`);
  return parts.join("\n");
}

// "Graph" tab — small leaf that pairs the live GraphView with the
// NodeInspector so a user can click through nodes while the run streams.
// The running node (if any) is whichever lifecycle state entry reports
// `state === "running"`; we surface that as the GraphView's
// `activeNodeId` so it gets the "thinking" ring even before a user
// clicks anything.
function PipelineGraphTab({
  detail,
  refetchKey,
  selectedNodeId,
  onSelect,
}: {
  detail: PipelineDetailT | null;
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
