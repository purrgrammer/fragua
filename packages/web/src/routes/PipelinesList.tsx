// GET /pipelines → table of runs.
//
// Presentation notes:
//   - Row markup is shared with Home's "Recent runs" via
//     `components/PipelineRow.tsx`. This file owns the table chrome
//     (header, empty/loading states); the row-level styling lives there.
//   - Loading, empty, and error states all render as purpose-built
//     components — we never dump a raw fetch error into the UI. Devs get
//     the underlying message via `console.warn` for diagnostics.

import { useEffect, useState } from "react";
import { PipelineRow } from "../components/PipelineRow.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import type { ApiClient, PipelineSummary } from "../lib/api.ts";

export interface PipelinesListProps {
  api: ApiClient;
}

type ListState = { kind: "loading" } | { kind: "ready"; rows: PipelineSummary[] } | { kind: "error" };

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
              <PipelineRow key={row.runId} row={row} variant="default" />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
