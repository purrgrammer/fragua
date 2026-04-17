// GET /pipelines/:id → detail page.
//
// At task-06 scope this renders the GraphView and a placeholder where the
// timeline (task 07) and drilldown (task 08) will live. We also fetch the
// pipeline detail so the header can show status + lastEventSeq, plus the
// run-level metrics (cost, tokens, duration) added in task P5.06.
//
// Live updates: we open an SSE stream (via `useSSE`) and bump a refetch
// key on every `node.*` event so the GraphView pulls a fresh SVG reflecting
// the new node states. Detail metadata is refreshed on the same signal.
//
// Error policy: detail fetch failures (e.g. deleted run, 500) render an
// `EmptyState` instead of a raw banner. Devs still get the underlying
// message via `console.warn`. The header gracefully degrades — if we
// never got `detail`, we just show the run id and a breadcrumb back.
//
// Formatting discipline: every user-visible timestamp goes through
// `lib/time.ts`; every number goes through `lib/format.ts`. No inline
// Intl calls, no raw ISO strings, no `.toFixed(2)`s in JSX.

import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { GraphView } from "../components/GraphView.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import type { ApiClient, PipelineDetail as PipelineDetailT } from "../lib/api.ts";
import { formatTokensCompact, formatTokensLong, formatUsd } from "../lib/format.ts";
import { formatDateTime, formatDuration, formatRelative, toIsoTitle } from "../lib/time.ts";
import { useSSE } from "../lib/useSSE.ts";

export interface PipelineDetailProps {
  api: ApiClient;
}

type DetailState = { kind: "loading" } | { kind: "ready"; detail: PipelineDetailT } | { kind: "error" };

export function PipelineDetail({ api }: PipelineDetailProps): JSX.Element {
  const { id = "" } = useParams();
  const [state, setState] = useState<DetailState>({ kind: "loading" });
  const [activeNode, setActiveNode] = useState<string | null>(null);

  const sseUrl = useMemo(() => (id ? api.getPipelineEventsUrl(id) : null), [api, id]);
  const { events } = useSSE(sseUrl, {
    filter: (t) => t.startsWith("node.") || t.startsWith("pipeline."),
  });

  // `events.length` is a deliberate trigger for live re-fetches; the
  // value isn't read inside the body. We key off the length (rather than
  // the full array) to avoid a deep compare. The directive below MUST
  // stay on a single line for Biome to attach it to the hook.
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

  return (
    <section className="max-w-5xl mx-auto space-y-6">
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
        <div>
          <h3 className="text-sm font-medium text-slate-700 mb-2">Graph</h3>
          <GraphView
            api={api}
            runId={id}
            {...(detail ? { detail } : {})}
            onNodeClick={setActiveNode}
            activeNodeId={activeNode}
            refetchKey={events.length}
          />
          {activeNode && (
            <p className="text-xs text-slate-600 mt-2" data-testid="active-node">
              Selected: <span className="font-mono">{activeNode}</span>
            </p>
          )}
        </div>
      )}

      {/* Placeholder slot for task 07 (timeline) and task 08 (drilldown). */}
      <div data-testid="timeline-placeholder" className="border border-dashed border-slate-300 rounded p-6 text-center">
        <p className="text-xs text-slate-500">Timeline arrives in task 07.</p>
      </div>
    </section>
  );
}

/**
 * Metadata strip rendered under the run-id heading. Split out so the
 * parent stays readable — there are half a dozen derived bits of info,
 * each with its own formatter + tooltip.
 *
 * Ordering (left→right) goes from "most relevant to the live state" to
 * "context": status, duration, started (relative), cost/tokens, event
 * count, workflow name.
 */
function DetailMetaLine({ detail }: { detail: PipelineDetailT }): JSX.Element {
  const totalTokens = detail.inputTokens + detail.outputTokens;
  const hasUsage = detail.costUsd > 0 || totalTokens > 0;
  const workflowLabel = detail.workflowName ?? detail.workflow;

  return (
    <p className="text-xs text-slate-600 mt-1 flex flex-wrap gap-x-2 gap-y-1 items-baseline">
      <span>
        status: <span data-testid="detail-status">{detail.status}</span>
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
        // Long-form precise values live in the tooltip.
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
