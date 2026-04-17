// GET /pipelines → table of runs.
//
// Presentation notes:
//   - The `runId` column shows the first 8 chars for readability (full id
//     rides on the `title` attr + the link href so nothing is lost).
//   - The status column uses the same emerald/rose/blue/slate token set as
//     the header health badge, so the two surfaces feel coherent.
//   - Loading, empty, and error states all render as purpose-built
//     components — we never dump a raw fetch error into the UI. Devs get
//     the underlying message via `console.warn` for diagnostics.
//   - **All ISO timestamps** pass through `formatRelative` + `toIsoTitle`
//     (see lib/time.ts) — never rendered raw. Same rule for numbers: cost
//     goes through `formatUsd`, tokens through `formatTokensCompact`
//     (lib/format.ts). The full values are always reachable via the `title`
//     attribute so operators can hover for precise values.
//   - Cost and tokens live in their own columns — operators scanning the
//     list usually want to compare one or the other in isolation (cheapest
//     runs vs largest runs), and a merged "Usage" column fought the eye.
//     Event count column is intentionally omitted — `lastEventSeq` on the
//     detail page is the right surface for that.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState } from "../components/ui/empty-state.tsx";
import type { ApiClient, PipelineSummary } from "../lib/api.ts";
import { formatTokensCompact, formatTokensLong, formatUsd, statusLabel } from "../lib/format.ts";
import { formatRelative, toIsoTitle } from "../lib/time.ts";

export interface PipelinesListProps {
  api: ApiClient;
}

type ListState = { kind: "loading" } | { kind: "ready"; rows: PipelineSummary[] } | { kind: "error" };

/** Number of leading runId chars shown in the table. */
const RUN_ID_SHORT_LEN = 8;

export function PipelinesList({ api }: PipelinesListProps): JSX.Element {
  const [state, setState] = useState<ListState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    api
      .listPipelines()
      .then((rows) => {
        if (!cancelled) setState({ kind: "ready", rows });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[PipelinesList] failed to load pipelines —", message);
        setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <section className="max-w-5xl mx-auto">
      <h2 className="text-lg font-semibold mb-4">Pipelines</h2>
      {state.kind === "loading" && (
        <p className="text-slate-500 text-sm" data-testid="pipelines-loading">
          Loading…
        </p>
      )}
      {state.kind === "error" && (
        <EmptyState
          data-testid="pipelines-error"
          title="Couldn't load pipelines"
          description="The server didn't respond as expected. Check the console for details, or retry shortly."
        />
      )}
      {state.kind === "ready" && state.rows.length === 0 && (
        <EmptyState
          data-testid="pipelines-empty"
          title="No runs yet"
          description={
            <span>
              Start one with <code className="font-mono">swarm run</code>.
            </span>
          }
        />
      )}
      {state.kind === "ready" && state.rows.length > 0 && (
        <table className="w-full text-sm border-collapse" data-testid="pipelines-table">
          <thead>
            <tr className="text-left text-slate-600 border-b border-slate-200">
              <th className="py-2 pr-4 font-medium">Run</th>
              <th className="py-2 pr-4 font-medium">Workflow</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Started</th>
              <th className="py-2 pr-4 font-medium text-right">Cost</th>
              <th className="py-2 pr-4 font-medium text-right">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {state.rows.map((row) => (
              <tr key={row.runId} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="py-2 pr-4 text-xs">
                  <Link
                    to={`/pipelines/${row.runId}`}
                    // Full id on hover so operators can still copy it.
                    title={row.runId}
                    data-testid={`run-link-${row.runId}`}
                    className="text-blue-700 hover:underline"
                  >
                    {shortenRunId(row.runId)}
                  </Link>
                </td>
                <td className="py-2 pr-4" title={row.workflow ?? ""}>
                  {row.workflowName ?? row.workflow ?? "(unknown)"}
                </td>
                <td className="py-2 pr-4">
                  <StatusPill status={row.status} />
                </td>
                <td
                  className="py-2 pr-4 text-slate-600"
                  // Full ISO on hover — matches the "precise value reachable
                  // via title" rule we use for every formatted field.
                  title={toIsoTitle(row.startedAt)}
                  data-testid={`started-${row.runId}`}
                >
                  {formatRelative(row.startedAt)}
                </td>
                <td
                  className="py-2 pr-4 text-slate-600 tabular-nums text-right whitespace-nowrap"
                  title={costTooltip(row)}
                  data-testid={`cost-${row.runId}`}
                >
                  {row.costUsd === 0 ? "—" : formatUsd(row.costUsd)}
                </td>
                <td
                  className="py-2 pr-4 text-slate-600 tabular-nums text-right whitespace-nowrap"
                  // Long-form input/output split on hover; compact total rendered.
                  title={tokensTooltip(row)}
                  data-testid={`tokens-${row.runId}`}
                >
                  {formatTokensCell(row)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Truncate a runId to its leading `RUN_ID_SHORT_LEN` chars, no ellipsis. */
function shortenRunId(runId: string): string {
  return runId.length > RUN_ID_SHORT_LEN ? runId.slice(0, RUN_ID_SHORT_LEN) : runId;
}

/** Tokens cell — compact input + output total. "—" when no LLM calls yet. */
function formatTokensCell(row: PipelineSummary): string {
  const total = row.inputTokens + row.outputTokens;
  if (total === 0) return "—";
  return formatTokensCompact(total);
}

/** Cost cell tooltip — precise USD, or a note when the run made no LLM calls. */
function costTooltip(row: PipelineSummary): string {
  if (row.costUsd === 0) return "no LLM usage reported";
  return `cost ${formatUsd(row.costUsd)}`;
}

/** Tokens cell tooltip — input / output split at long precision. */
function tokensTooltip(row: PipelineSummary): string {
  const total = row.inputTokens + row.outputTokens;
  if (total === 0) return "no LLM usage reported";
  return `input ${formatTokensLong(row.inputTokens)} · output ${formatTokensLong(row.outputTokens)} tokens`;
}

function StatusPill({ status }: { status: PipelineSummary["status"] }): JSX.Element {
  // Token set matches the HealthBadge in App.tsx:
  //   connected → emerald, error → rose, loading → slate.
  // `running` adds blue because a live run is distinct from both "healthy"
  // (completed success) and "absent" (unknown). `fail` reuses rose.
  const tone =
    status === "success"
      ? "bg-emerald-100 text-emerald-800 border-emerald-300"
      : status === "fail"
        ? "bg-rose-100 text-rose-800 border-rose-300"
        : status === "running"
          ? "bg-blue-100 text-blue-800 border-blue-300"
          : "bg-slate-100 text-slate-700 border-slate-300";
  return (
    <span
      data-testid={`status-${status}`}
      className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {statusLabel(status)}
    </span>
  );
}
