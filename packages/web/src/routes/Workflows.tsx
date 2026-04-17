// /workflows — list of `.dot` workflow definitions exposed by the
// server's `GET /workflows`. Read-only for now; launching a workflow
// is owned by P5.14.
//
// Columns: Name / Path / Short SHA. The path goes through `<code>` so
// operators can spot it at a glance and the SHA stays short to avoid
// hijacking the row.

import { FileCode2 } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import type { ApiClient, WorkflowSummary } from "../lib/api.ts";

export interface WorkflowsProps {
  api: ApiClient;
  /** Test injection — same pattern as `Home.tsx`. */
  fetcher?: () => Promise<WorkflowSummary[]>;
}

type LoadState = { kind: "loading" } | { kind: "ready"; rows: WorkflowSummary[] } | { kind: "error" };

export function Workflows({ api, fetcher }: WorkflowsProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const load = fetcher ?? (() => api.listWorkflows());
    load()
      .then((rows) => {
        if (!cancelled) setState({ kind: "ready", rows });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[Workflows] failed to load workflows —", message);
        setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [api, fetcher]);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-heading text-base font-semibold">Workflows</h2>
      {state.kind === "loading" && (
        <p className="text-muted-foreground text-sm" data-testid="workflows-loading">
          Loading…
        </p>
      )}
      {state.kind === "error" && (
        <EmptyState
          data-testid="workflows-error"
          title="Couldn't load workflows"
          description="The server didn't respond as expected. Check the console for details, or retry shortly."
        />
      )}
      {state.kind === "ready" && state.rows.length === 0 && (
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
      {state.kind === "ready" && state.rows.length > 0 && (
        <Table data-testid="workflows-table">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Path</TableHead>
              <TableHead>SHA</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.rows.map((row) => (
              <TableRow key={row.path} data-testid={`workflow-row-${row.name}`}>
                <TableCell className="font-medium">{row.label ?? row.name}</TableCell>
                <TableCell>
                  <code className="font-mono text-xs text-muted-foreground">{row.path}</code>
                </TableCell>
                <TableCell>
                  <code className="font-mono text-xs">{shortSha(row.sha)}</code>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/** First 7 chars — git's standard short-sha format. */
function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}
