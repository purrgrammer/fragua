// /workflows — list of `.yaml` workflow definitions exposed by the
// server's `GET /workflows`. Read-only for now; launching a workflow
// is owned by P5.14.
//
// Columns: Name / Source / Path / Short SHA. `Source` resolves a
// workflow's owning cwd: the global source (`~/.fragua/workflows/`) shows
// `global`; a project source shows the project's basename with the full
// cwd in `title=`. Long paths truncate inside the cell rather than
// wrapping or pushing the table wider than its container — the
// `table-fixed` layout + `min-w-0` wrapper enforce this. Names may
// collide across sources, so the row key + detail link both include
// `cwd` to avoid pointing two rows at the same URL.

import { useQuery } from "@tanstack/react-query";
import { FileCode2 } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Input } from "../components/ui/input.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import { WorkflowLink } from "../components/WorkflowLink.tsx";
import { queries } from "../lib/queries.ts";

export function Workflows(): JSX.Element {
  const { data: rows, isPending, isError, error } = useQuery(queries.workflows.list());
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (error)
      console.warn("[Workflows] failed to load workflows —", error instanceof Error ? error.message : String(error));
  }, [error]);

  const needle = filter.trim().toLowerCase();
  const filtered = (rows ?? []).filter(
    (row) => row.name.toLowerCase().includes(needle) || (row.label ?? "").toLowerCase().includes(needle),
  );

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
              Add a <code className="font-mono">.yaml</code> file under{" "}
              <code className="font-mono">.fragua/workflows/</code>, or run{" "}
              <code className="font-mono">fragua init</code> if this project hasn't been initialized.
            </span>
          }
        />
      )}
      {rows && rows.length > 0 && (
        <Input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name…"
          aria-label="Filter workflows"
          className="max-w-64"
          data-testid="workflows-filter"
        />
      )}
      {rows && rows.length > 0 && filtered.length === 0 && (
        <p className="text-sw-sm text-sw-muted" data-testid="workflows-no-match">
          No workflows match “{filter.trim()}”.
        </p>
      )}
      {filtered.length > 0 && (
        <div className="w-full min-w-0 overflow-x-auto">
          <Table data-testid="workflows-table" className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-56">Name</TableHead>
                <TableHead className="w-40">Source</TableHead>
                <TableHead>Path</TableHead>
                <TableHead className="w-24">SHA</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((row) => {
                const sourceLabel = row.cwd ? basename(row.cwd) : "global";
                const sourceTitle = row.cwd ?? "~/.fragua/workflows";
                const rowKey = `${row.cwd ?? ""}::${row.path}`;
                return (
                  <TableRow key={rowKey} data-testid={`workflow-row-${row.name}`}>
                    <TableCell className="max-w-0 truncate font-medium" title={row.label ?? row.name}>
                      <WorkflowLink
                        name={row.name}
                        cwd={row.cwd}
                        variant="plain"
                        className="transition-colors duration-[var(--sw-duration-hover)] hover:underline"
                        data-testid={`workflow-link-${row.name}`}
                      >
                        {row.label ?? row.name}
                      </WorkflowLink>
                    </TableCell>
                    <TableCell className="max-w-0 truncate" title={sourceTitle}>
                      <code className="font-mono text-xs text-sw-muted" data-testid={`workflow-source-${row.name}`}>
                        {sourceLabel}
                      </code>
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
                );
              })}
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

function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}
