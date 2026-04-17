// GET /pipelines/:id → detail page.
//
// Post-P5.08 layout is minimal by design: a header with run identity +
// metrics, and a single primary surface — `<PipelineConversation />` —
// that streams the run as an AI-Elements-based conversation. The graph
// "map" panel and the timeline placeholder have been removed; the
// conversation is the main view, period.
//
// Data flow:
//   - `useRunConversation(api, id)` owns the event pipeline end-to-end:
//     a REST bootstrap fetches the full history, then SSE delivers new
//     events. Events are folded into the conversation tree via
//     `applyEvent` on arrival; the client never keeps a raw-event
//     buffer, so memory scales with conversation content (KB) rather
//     than event count (MB on a 23K-event run).
//   - `getPipeline(id)` still drives the header metrics. We refetch on
//     `totalEvents` changes so cost / tokens / duration stay live.
//
// Error policy: unchanged — bootstrap or detail fetch failures render
// `EmptyState`, never a raw banner.

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PipelineConversation } from "../components/PipelineConversation.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import type { ApiClient, PipelineDetail as PipelineDetailT } from "../lib/api.ts";
import { formatTokensCompact, formatTokensLong, formatUsd, statusLabel } from "../lib/format.ts";
import { formatDateTime, formatDuration, formatRelative, toIsoTitle } from "../lib/time.ts";
import { useRunConversation } from "../lib/useRunConversation.ts";

export interface PipelineDetailProps {
  api: ApiClient;
}

type DetailState = { kind: "loading" } | { kind: "ready"; detail: PipelineDetailT } | { kind: "error" };

export function PipelineDetail({ api }: PipelineDetailProps): JSX.Element {
  const { id = "" } = useParams();
  const [state, setState] = useState<DetailState>({ kind: "loading" });

  // Bootstrap + live stream, folded into a conversation tree. No raw
  // event buffer on the client — the reducer is the only state we keep.
  const { conversation, status: convStatus, totalEvents } = useRunConversation(api, id || null);
  const isLoading = convStatus === "loading";

  // Refetch run detail on every applied event so the header metrics stay
  // live (cost, tokens, duration). Cheap; the handler is 404-safe.
  // biome-ignore lint/correctness/useExhaustiveDependencies: totalEvents is an intentional re-fetch trigger; its value is not read in the body.
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
  }, [api, id, totalEvents]);

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
  const isLive = convStatus === "live" || convStatus === "loading";

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
        <div
          data-testid="conversation-region"
          className="h-[60vh] xl:h-[calc(100vh-14rem)] border rounded-md overflow-hidden bg-background"
        >
          <PipelineConversation
            conversation={conversation}
            nodeStates={detail?.nodes}
            isLive={isLive}
            isLoading={isLoading}
          />
        </div>
      )}
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

/** Mirror of PipelinesList's shortener so both surfaces truncate identically. */
function shortenRunId(runId: string): string {
  return runId.length > RUN_ID_SHORT_LEN ? runId.slice(0, RUN_ID_SHORT_LEN) : runId;
}
