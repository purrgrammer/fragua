// GET /runs → table of runs.
//
// Presentation notes:
//   - The table is intentionally minimal: Title / Workflow / Status.
//     Per-run detail (started-at, cost, tokens, events, duration) lives
//     on the run detail page, not here.
//   - Row markup is shared with the Control Center's Running strip via
//     `components/RunRow.tsx`. This file owns the table chrome
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
import { RunRow } from "../components/RunRow.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { queries } from "../lib/queries.ts";

export function RunsList(): JSX.Element {
  const { data: rows, isPending, isError, error } = useQuery(queries.runs.list());

  useEffect(() => {
    if (error) console.warn("[RunsList] failed to load runs —", error instanceof Error ? error.message : String(error));
  }, [error]);

  return (
    <section className="flex w-full min-w-0 flex-col gap-3">
      <h2 className="font-heading text-base font-semibold">Runs</h2>
      {isPending && (
        <p className="text-sw-muted text-sm" data-testid="runs-loading">
          Loading…
        </p>
      )}
      {isError && (
        <EmptyState
          data-testid="runs-error"
          title="Couldn't load runs"
          description="The server didn't respond as expected. Check the console for details, or retry shortly."
        />
      )}
      {rows && rows.length === 0 && (
        <EmptyState
          data-testid="runs-empty"
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
          {/* Raw <table> (not the shadcn Table primitive) so <RunRow> keeps
              control of row layout. Header classes mirror TableHead's treatment
              (UPPERCASE + 0.06em tracking + text-xs + muted) so list headers
              feel consistent across the app. */}
          <table className="w-full table-fixed border-collapse" data-testid="runs-table">
            <thead>
              <tr className="border-b">
                <th className="px-2 py-2 text-left align-middle text-xs font-medium uppercase tracking-[0.06em] text-sw-muted">
                  Title
                </th>
                <th className="w-40 px-2 py-2 text-left align-middle text-xs font-medium uppercase tracking-[0.06em] text-sw-muted">
                  Workflow
                </th>
                <th className="w-28 px-2 py-2 text-right align-middle text-xs font-medium uppercase tracking-[0.06em] text-sw-muted">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <RunRow key={row.runId} row={row} variant="default" />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
