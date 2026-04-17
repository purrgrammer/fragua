// GET /pipelines/:id → detail page.
//
// Layout (post-P5.08):
//   1. Header — runId, status, metrics (unchanged).
//   2. Main content — <PipelineConversation /> fills the available
//      height and owns its own scroll, streaming AI-Elements messages
//      as events arrive.
//   3. Secondary — <GraphView /> demoted to a collapsible "map" panel.
//      Default: open-as-sidebar on ≥ 1280px viewports, closed on
//      smaller ones. Either way, GraphView stays mounted (Radix
//      `Collapsible` only toggles visibility) so the existing
//      data-node-id selectors in route tests keep resolving.
//   4. Timeline placeholder — left untouched until P5.07 lands.
//
// SSE strategy:
//   - We subscribe to the run's events (no type filter) and thread two
//     derived values into the UI: (a) `events.length` drives a refetch
//     of the pipeline detail (so the header metrics stay live); (b) the
//     parsed event stream feeds `eventsToConversation` which hands
//     <PipelineConversation> a structured view. The hook's internal
//     ring buffer caps at 500 by default — fine for the near-term UI
//     since conversation state is a projection, not a replay, and a
//     long-running pipeline will just show the trailing window until
//     we add server-side historical fetch (tracked separately).
//
// Graph → conversation focus:
//   - Clicking a node in the map scrolls the conversation to the
//     corresponding `<section id="node-section-<id>">`. We stash the id
//     in `activeNode` so the graph highlights it too.
//
// Error policy: unchanged — failures render the EmptyState.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { GraphView } from "../components/GraphView.tsx";
import { PipelineConversation } from "../components/PipelineConversation.tsx";
import { Button } from "../components/ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import type { ApiClient, PipelineDetail as PipelineDetailT } from "../lib/api.ts";
import {
  type PipelineConversation as ConversationTree,
  eventsToConversation,
  parseSSEEvents,
} from "../lib/events-to-conversation.ts";
import { formatTokensCompact, formatTokensLong, formatUsd, statusLabel } from "../lib/format.ts";
import { formatDateTime, formatDuration, formatRelative, toIsoTitle } from "../lib/time.ts";
import { useSSE } from "../lib/useSSE.ts";

export interface PipelineDetailProps {
  api: ApiClient;
}

type DetailState = { kind: "loading" } | { kind: "ready"; detail: PipelineDetailT } | { kind: "error" };

/** Breakpoint at which the graph panel opens as a sidebar by default. */
const WIDE_VIEWPORT_PX = 1280;

function useIsWideViewport(): boolean {
  const [isWide, setIsWide] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(`(min-width: ${WIDE_VIEWPORT_PX}px)`).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(`(min-width: ${WIDE_VIEWPORT_PX}px)`);
    const handler = (e: MediaQueryListEvent) => setIsWide(e.matches);
    // Older Safari uses addListener; newer browsers use addEventListener.
    if (mq.addEventListener) {
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []);

  return isWide;
}

export function PipelineDetail({ api }: PipelineDetailProps): JSX.Element {
  const { id = "" } = useParams();
  const [state, setState] = useState<DetailState>({ kind: "loading" });
  const [activeNode, setActiveNode] = useState<string | null>(null);

  const sseUrl = useMemo(() => (id ? api.getPipelineEventsUrl(id) : null), [api, id]);
  // Subscribe to ALL events — we both fold them into the conversation
  // view AND use their count as a refetch trigger for detail metrics.
  const { events, status: sseStatus } = useSSE(sseUrl);

  // Refetch detail on every new event (length change). Same rationale
  // as pre-P5.08 — we want live header metrics.
  // biome-ignore lint/correctness/useExhaustiveDependencies: events.length is an intentional re-fetch trigger; its value is not read in the body.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api
      .getPipeline(id)
      .then((d) => {
        if (!cancelled) setState({ kind: "ready", detail: d });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[PipelineDetail] failed to load pipeline", id, "—", message);
        setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [api, id, events.length]);

  // Fold events into a conversation tree. Recomputed whenever the
  // event count changes — the reducer is cheap and pure.
  const conversation = useMemo<ConversationTree>(() => {
    const raw = parseSSEEvents(events);
    return eventsToConversation(raw);
  }, [events]);

  const isWide = useIsWideViewport();
  const [graphOpen, setGraphOpen] = useState<boolean>(isWide);
  useEffect(() => {
    // Re-sync on viewport changes; users who manually toggled on a
    // narrow viewport keep their preference on the same viewport.
    setGraphOpen(isWide);
  }, [isWide]);

  // Scroll the conversation to the section matching the clicked node.
  const focusNode = useCallback((nodeId: string) => {
    setActiveNode(nodeId);
    if (typeof document === "undefined") return;
    const el = document.getElementById(`node-section-${nodeId}`);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  if (!id) {
    return (
      <EmptyState
        data-testid="detail-missing-id"
        title="Missing pipeline id"
        description="The URL didn't include a run identifier."
        action={
          <Link to="/" className="text-xs text-blue-700 hover:underline">
            ← all pipelines
          </Link>
        }
      />
    );
  }

  const detail = state.kind === "ready" ? state.detail : null;
  // Node-state summary for the collapsed "Open map" trigger. This is
  // a cheap reduction on a small array; no hook needed.
  const summary = summariseNodeStates(detail);
  const isLive = sseStatus === "open" || sseStatus === "connecting";

  return (
    <section className="max-w-6xl mx-auto space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <Link to="/" className="text-xs text-blue-700 hover:underline">
            ← all pipelines
          </Link>
          <h2 className="text-lg font-semibold mt-1" title={id}>
            {shortenRunId(id)}
          </h2>
          {detail && <DetailMetaLine detail={detail} />}
        </div>
      </header>

      {state.kind === "error" && (
        <EmptyState
          data-testid="detail-error"
          title="Couldn't load this run"
          description="The server didn't return details for this run. It may have been deleted or the request failed — check the console for specifics."
          action={
            <Link to="/" className="text-xs text-blue-700 hover:underline">
              ← all pipelines
            </Link>
          }
        />
      )}

      {state.kind !== "error" && (
        <div className="flex flex-col xl:flex-row gap-4">
          {/* Primary: conversation. Owns vertical space; scrolls itself. */}
          <div
            data-testid="conversation-region"
            className="flex-1 min-h-[60vh] xl:min-h-[calc(100vh-14rem)] border rounded-md overflow-hidden bg-background"
          >
            <PipelineConversation conversation={conversation} nodeStates={detail?.nodes} isLive={isLive} />
          </div>

          {/* Secondary: the graph as a collapsible "map". */}
          <aside data-testid="graph-panel" className="xl:w-[28rem] xl:shrink-0">
            <Collapsible open={graphOpen} onOpenChange={setGraphOpen}>
              <div className="flex items-center gap-2 mb-2">
                <CollapsibleTrigger asChild>
                  <Button data-testid="graph-panel-trigger" variant="outline" size="sm">
                    {graphOpen ? "▾ Hide map" : "▸ Open map"}
                  </Button>
                </CollapsibleTrigger>
                {!graphOpen && summary && <span className="text-xs text-muted-foreground">{summary}</span>}
              </div>
              {/* `forceMount` keeps <GraphView> mounted even when the
                  panel is closed on narrow viewports. This preserves the
                  [data-node-id="…"] selectors that route tests rely on
                  AND means graph state (layout, active-node highlight)
                  is ready the instant a user opens the map. Radix adds
                  `hidden` automatically when closed, so the CSS hides
                  it — querySelector still finds the nodes. */}
              <CollapsibleContent forceMount>
                <GraphView
                  api={api}
                  runId={id}
                  {...(detail ? { detail } : {})}
                  onNodeClick={focusNode}
                  activeNodeId={activeNode}
                  refetchKey={events.length}
                />
                {activeNode && (
                  <p className="text-xs text-slate-600 mt-2" data-testid="active-node">
                    Selected: <span className="font-mono">{activeNode}</span>
                  </p>
                )}
              </CollapsibleContent>
            </Collapsible>
          </aside>
        </div>
      )}

      {/* Placeholder slot for task 07 (timeline). Kept untouched per the
          P5.08 spec until the timeline task ships. */}
      <div data-testid="timeline-placeholder" className="border border-dashed border-slate-300 rounded p-6 text-center">
        <p className="text-xs text-slate-500">Timeline arrives in task 07.</p>
      </div>
    </section>
  );
}

/**
 * Metadata strip rendered under the run-id heading. Unchanged from the
 * pre-P5.08 implementation — still a dense, tooltip-rich one-liner.
 */
function DetailMetaLine({ detail }: { detail: PipelineDetailT }): JSX.Element {
  const totalTokens = detail.inputTokens + detail.outputTokens;
  const hasUsage = detail.costUsd > 0 || totalTokens > 0;
  const workflowLabel = detail.workflowName ?? detail.workflow;

  return (
    <p className="text-xs text-slate-600 mt-1 flex flex-wrap gap-x-2 gap-y-1 items-baseline">
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
          <span title={detail.workflow ?? ""}>workflow: {workflowLabel}</span>
        </>
      )}
    </p>
  );
}

const RUN_ID_SHORT_LEN = 8;

function shortenRunId(runId: string): string {
  return runId.length > RUN_ID_SHORT_LEN ? runId.slice(0, RUN_ID_SHORT_LEN) : runId;
}

function summariseNodeStates(detail: PipelineDetailT | null): string {
  if (!detail?.nodes?.length) return "";
  const counts = new Map<string, number>();
  for (const n of detail.nodes) counts.set(n.state, (counts.get(n.state) ?? 0) + 1);
  const parts: string[] = [];
  for (const [state, n] of counts) parts.push(`${n} ${state}`);
  return parts.join(" · ");
}
