// Compact row component for pipeline summaries. Originally inlined in
// `PipelinesList`; factored out here so Home's "Recent runs" section
// can reuse the exact same row markup without forking the styling
// (which would inevitably drift). The two callers differ only in
// `variant`:
//
//   - `"default"` — table-row layout used by `PipelinesList` inside a
//     `<table>`. Renders a `<tr>` so the surrounding `<thead>` /
//     `<tbody>` semantics survive.
//   - `"compact"` — single-line link card used in Home's recent-runs
//     list. Renders an `<a>` so the whole row is one click target.
//
// Formatting discipline (timestamps via `lib/time.ts`, numbers via
// `lib/format.ts`, full values reachable via `title`) carries over
// verbatim from the original inline version.

import { Link } from "react-router-dom";
import type { PipelineSummary } from "../lib/api.ts";
import { formatTokensCompact, formatTokensLong, formatUsd, statusLabel } from "../lib/format.ts";
import { formatRelative, toIsoTitle } from "../lib/time.ts";

/** Number of leading runId chars shown in the row. */
const RUN_ID_SHORT_LEN = 8;

export interface PipelineRowProps {
  row: PipelineSummary;
  variant?: "default" | "compact";
}

export function PipelineRow({ row, variant = "default" }: PipelineRowProps): JSX.Element {
  if (variant === "compact") return <CompactRow row={row} />;
  return <TableRow row={row} />;
}

function TableRow({ row }: { row: PipelineSummary }): JSX.Element {
  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50">
      <td className="py-2 pr-4 text-xs">
        <Link
          to={`/pipelines/${row.runId}`}
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
      <td className="py-2 pr-4 text-slate-600" title={toIsoTitle(row.startedAt)} data-testid={`started-${row.runId}`}>
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
        title={tokensTooltip(row)}
        data-testid={`tokens-${row.runId}`}
      >
        {formatTokensCell(row)}
      </td>
    </tr>
  );
}

function CompactRow({ row }: { row: PipelineSummary }): JSX.Element {
  // Single-link layout. Everything in one `<a>` so keyboards / screen
  // readers see exactly one focusable element per row.
  return (
    <Link
      to={`/pipelines/${row.runId}`}
      title={row.runId}
      data-testid={`recent-run-${row.runId}`}
      className="flex items-center gap-3 rounded-md border border-border/60 bg-card px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
    >
      <span className="font-mono text-xs text-muted-foreground shrink-0">{shortenRunId(row.runId)}</span>
      <span className="flex-1 min-w-0 truncate" title={row.workflow ?? ""}>
        {row.workflowName ?? row.workflow ?? "(unknown)"}
      </span>
      <StatusPill status={row.status} />
      <span className="text-xs text-muted-foreground shrink-0" title={toIsoTitle(row.startedAt)}>
        {formatRelative(row.startedAt)}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums shrink-0 hidden sm:inline" title={costTooltip(row)}>
        {row.costUsd === 0 ? "—" : formatUsd(row.costUsd)}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums shrink-0 hidden sm:inline" title={tokensTooltip(row)}>
        {formatTokensCell(row)}
      </span>
    </Link>
  );
}

/** Truncate a runId to its leading `RUN_ID_SHORT_LEN` chars, no ellipsis. */
export function shortenRunId(runId: string): string {
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

export function StatusPill({ status }: { status: PipelineSummary["status"] }): JSX.Element {
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
