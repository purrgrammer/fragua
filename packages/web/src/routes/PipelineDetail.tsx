// GET /pipelines/:id → detail page.
//
// Post-P5.08 layout is minimal by design: a header with run identity +
// metrics, and a single primary surface — `<PipelineConversation />` —
// that streams the run as an AI-Elements-based conversation. The graph
// "map" panel and the timeline placeholder have been removed; the
// conversation is the main view, period.
//
// Layout:
//   - Section is `h-full flex flex-col min-w-0` — no arbitrary
//     `max-w-*` clamp, so the page fills the main region at any
//     viewport width.
//   - The h2 is `truncate` inside a `min-w-0` parent so a long
//     auto-generated title shortens with an ellipsis instead of
//     stretching the header row.
//   - The conversation region uses `flex-1 min-h-0` to absorb all
//     remaining vertical space without overflowing.
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
import { StepInspector } from "../components/StepInspector.tsx";
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
  // Declared at the top — Rules of Hooks demands we not skip past any
  // hook on an early return (the `if (!id) return <EmptyState/>` below
  // would do exactly that if this sat after it).
  const [view, setView] = useState<"conversation" | "steps">("conversation");

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
    // Full-height flex column so the conversation region can consume all
    // remaining space via `flex-1 min-h-0` rather than hard-coding a
    // viewport fraction. `min-h-0` + `min-w-0` are both load-bearing —
    // without them the flex child refuses to shrink and long titles or
    // wide content overflow their parent.
    <section className="flex h-full w-full min-w-0 flex-col gap-4">
      <header className="flex min-w-0 items-baseline justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link to="/" className="text-xs text-blue-700 hover:underline">
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
              aria-selected={view === "steps"}
              data-testid="view-tab-steps"
              onClick={() => setView("steps")}
              className={`px-3 py-1 rounded-md border ${view === "steps" ? "bg-muted" : "bg-transparent"}`}
            >
              Steps
            </button>
          </div>
          <div
            data-testid={view === "conversation" ? "conversation-region" : "steps-region"}
            className="min-h-0 min-w-0 flex-1 overflow-auto rounded-md border bg-background"
          >
            {view === "conversation" ? (
              <PipelineConversation
                conversation={conversation}
                nodeStates={detail?.nodes}
                isLive={isLive}
                isLoading={isLoading}
              />
            ) : (
              <StepInspector api={api} runId={id} totalEvents={totalEvents} />
            )}
          </div>
        </>
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

/** Mirror of PipelinesList's shortener so both surfaces truncate identically. */
function shortenRunId(runId: string): string {
  return runId.length > RUN_ID_SHORT_LEN ? runId.slice(0, RUN_ID_SHORT_LEN) : runId;
}

/** Heading priority for Wave-2b runs: title → raw input (clamped).
 * Legacy runs (no title, no input) fall through to the pre-Wave-2b
 * behaviour of showing the shortened run id so existing expectations —
 * and existing tests — don't shift. */
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
