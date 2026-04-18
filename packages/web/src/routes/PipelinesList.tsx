// GET /pipelines → table of runs.
//
// Presentation notes:
//   - The table is intentionally minimal: Title / Workflow / Status.
//     Per-run detail (started-at, cost, tokens, events, duration) lives
//     on the pipeline detail page, not here.
//   - Row markup is shared with Home's "Recent runs" via
//     `components/PipelineRow.tsx`. This file owns the table chrome
//     (header, empty/loading states); the row-level styling lives there.
//   - Loading, empty, and error states all render as purpose-built
//     components — we never dump a raw fetch error into the UI. Devs get
//     the underlying message via `console.warn` for diagnostics.
//   - The section is full-bleed — we dropped the historical
//     `max-w-5xl mx-auto` clamp so the table uses the real main-column
//     width; long titles truncate inside the row rather than forcing
//     horizontal scroll or shrinking into a narrow column.

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { PipelineRow } from "../components/PipelineRow.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { queries } from "../lib/queries.ts";

export function PipelinesList(): JSX.Element {
  const { data: rows, isPending, isError, error } = useQuery(queries.pipelines.list());

  useEffect(() => {
    if (error)
      console.warn(
        "[PipelinesList] failed to load pipelines —",
        error instanceof Error ? error.message : String(error),
      );
  }, [error]);

  return (
    <section className="flex w-full min-w-0 flex-col gap-3">
      <h2 className="font-heading text-base font-semibold">Pipelines</h2>
      {isPending && (
        <p className="text-slate-500 text-sm" data-testid="pipelines-loading">
          Loading…
        </p>
      )}
      {isError && (
        <EmptyState
          data-testid="pipelines-error"
          title="Couldn't load pipelines"
          description="The server didn't respond as expected. Check the console for details, or retry shortly."
        />
      )}
      {rows && rows.length === 0 && (
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
      {rows && rows.length > 0 && (
        <div className="w-full min-w-0 overflow-x-auto">
          {/* Raw <table> (not the shadcn Table primitive) so <PipelineRow> keeps
              control of row layout. Header classes mirror TableHead's treatment
              (UPPERCASE + 0.06em tracking + text-xs + muted) so list headers
              feel consistent across the app. */}
          <table className="w-full table-fixed border-collapse" data-testid="pipelines-table">
            <thead>
              <tr className="border-b">
                <th className="px-2 py-2 text-left align-middle text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">
                  Title
                </th>
                <th className="w-40 px-2 py-2 text-left align-middle text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">
                  Workflow
                </th>
                <th className="w-28 px-2 py-2 text-right align-middle text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <PipelineRow key={row.runId} row={row} variant="default" />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
