// GET /pipelines/:id → run detail page.
//
// Tabs:
//   Events       — raw store event log (new fact.* / intent.* shapes)
//   Conversation — AI-Elements conversation view, populated by agent.*
//                  events when handlers use packages/agent LLM backends
//   Graph        — live DAG with node inspector
//   Steps        — per-step LLM context dump (agent-runtime only)

import { parseDotSource } from "@swarm/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { EventLog } from "../components/EventLog.tsx";
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

type TabId = "events" | "conversation" | "graph" | "steps";

export function PipelineDetail(): JSX.Element {
  const { id = "" } = useParams();
  const [view, setView] = useState<TabId>("conversation");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const { conversation, status: convStatus, totalEvents, controlEvents } = useRunConversation(id || null);
  const isLoading = convStatus === "loading";
  const isLive = convStatus === "live" || convStatus === "loading";

  const qc = useQueryClient();
  const { data: detail, isError } = useQuery({ ...queries.pipelines.detail(id), enabled: !!id });

  // Keep header metrics live with the event stream.
  // biome-ignore lint/correctness/useExhaustiveDependencies: totalEvents is the intentional trigger.
  useEffect(() => {
    if (id) void qc.invalidateQueries({ queryKey: queries.pipelines.detail(id).queryKey });
  }, [totalEvents]);

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
      <header className="flex min-w-0 items-baseline justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link to="/runs" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
            ← all runs
          </Link>
          <h2 className="mt-1 truncate text-lg font-semibold" title={id}>
            {detail ? headingText(detail) : shortenRunId(id)}
          </h2>
          <p className="mt-0.5 truncate font-mono text-xs text-slate-500" title={id}>
            {shortenRunId(id)}
          </p>
          {detail && <DetailMetaLine detail={detail} />}
        </div>
      </header>

      {isError && !detail && (
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
      )}

      {!(isError && !detail) && (
        <>
          <div role="tablist" aria-label="Detail view" className="flex gap-2 text-xs">
            <TabButton current={view} id="conversation" onSelect={setView}>Conversation</TabButton>
            <TabButton current={view} id="events" onSelect={setView}>Events</TabButton>
            <TabButton current={view} id="graph" onSelect={setView}>Graph</TabButton>
            <TabButton current={view} id="steps" onSelect={setView}>Steps</TabButton>
          </div>
          <div
            data-testid={`${view}-region`}
            className="min-h-0 min-w-0 flex-1 overflow-auto rounded-md border bg-background"
          >
            {view === "events" && <EventLog runId={id} refetchKey={totalEvents} />}
            {view === "conversation" && (
              <PipelineConversation
                conversation={conversation}
                nodeStates={detail?.nodes}
                isLive={isLive}
                isLoading={isLoading}
                userInput={detail?.input ?? null}
              />
            )}
            {view === "graph" && (
              <PipelineGraphTab
                detail={detail ?? null}
                refetchKey={totalEvents}
                selectedNodeId={selectedNodeId}
                onSelect={setSelectedNodeId}
              />
            )}
            {view === "steps" && <StepInspector runId={id} totalEvents={totalEvents} />}
          </div>
          {view === "conversation" && detail?.status === "running" && (
            <SteerInput runId={id} events={controlEvents} />
          )}
        </>
      )}
    </section>
  );
}

function TabButton({
  current,
  id,
  onSelect,
  children,
}: {
  current: TabId;
  id: TabId;
  onSelect: (t: TabId) => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={current === id}
      data-testid={`view-tab-${id}`}
      onClick={() => onSelect(id)}
      className={`px-3 py-1 rounded-md border ${current === id ? "bg-muted" : "bg-transparent"}`}
    >
      {children}
    </button>
  );
}

function DetailMetaLine({ detail }: { detail: PipelineDetailT }): JSX.Element {
  const totalTokens = detail.inputTokens + detail.outputTokens;
  const hasUsage = detail.costUsd > 0 || totalTokens > 0;
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
