// /workflows — list of `.dot` workflow definitions exposed by the
// server's `GET /workflows`. Read-only for now; launching a workflow
// is owned by P5.14.
//
// Columns: Name / Path / Short SHA. The path is shown in `<code>` so
// operators can spot it at a glance and the SHA stays short to avoid
// hijacking the row. Long paths truncate inside the cell rather than
// wrapping or pushing the table wider than its container — the
// `table-fixed` layout + `min-w-0` wrapper enforce this.

import { useQuery } from "@tanstack/react-query";
import { FileCode2 } from "lucide-react";
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import { queries } from "../lib/queries.ts";

export function Workflows(): JSX.Element {
  const { data: rows, isPending, isError, error } = useQuery(queries.workflows.list());

  useEffect(() => {
    if (error)
      console.warn("[Workflows] failed to load workflows —", error instanceof Error ? error.message : String(error));
  }, [error]);

  return (
    <section className="flex w-full min-w-0 flex-col gap-3">
      <h2 className="font-heading text-base font-semibold">Workflows</h2>
      {isPending && (
        <p className="text-sw-muted text-sm" data-testid="workflows-loading">
          Loading…
        </p>
      )}
      {isError && (
        <EmptyState
          data-testid="workflows-error"
          title="Couldn't load workflows"
          description="The server didn't respond as expected. Check the console for details, or retry shortly."
        />
      )}
      {rows && rows.length === 0 && (
        <EmptyState
          data-testid="workflows-empty"
          icon={<FileCode2 className="size-6" />}
          title="No workflows configured"
          description={
            <span>
              Add a <code className="font-mono">.dot</code> file under <code className="font-mono">workflows/</code>.
            </span>
          }
        />
      )}
      {rows && rows.length > 0 && (
        <div className="w-full min-w-0 overflow-x-auto">
          <Table data-testid="workflows-table" className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-56">Name</TableHead>
                <TableHead>Path</TableHead>
                <TableHead className="w-24">SHA</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.path} data-testid={`workflow-row-${row.name}`}>
                  <TableCell className="max-w-0 truncate font-medium" title={row.label ?? row.name}>
                    <Link
                      to={`/workflows/${encodeURIComponent(row.name)}`}
                      className="transition-colors duration-[var(--sw-duration-hover)] hover:underline"
                      data-testid={`workflow-link-${row.name}`}
                    >
                      {row.label ?? row.name}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-0">
                    <code className="block truncate font-mono text-xs text-sw-muted" title={row.path}>
                      {row.path}
                    </code>
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-xs" title={row.sha}>
                      {shortSha(row.sha)}
                    </code>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}
