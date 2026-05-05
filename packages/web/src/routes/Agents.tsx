// /agents — discovered named sub-agent profiles. Read-only list with
// a rescan button. Click a row to open the detail view (metadata
// header + the prompt body the sub-agent receives verbatim).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, RefreshCw } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "../components/ui/button.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import { queries } from "../lib/queries.ts";

export function Agents(): JSX.Element {
  const [searchParams] = useSearchParams();
  const projectCwd = searchParams.get("project_cwd") ?? undefined;
  const { data, isPending, isError, refetch, isRefetching } = useQuery(queries.agents.list(projectCwd));
  const qc = useQueryClient();

  const onRescan = (): void => {
    qc.invalidateQueries({ queryKey: queries.agents.all() });
    void refetch();
  };

  return (
    <section className="flex w-full min-w-0 flex-col gap-3">
      <header className="flex items-center justify-between">
        <h2 className="font-heading text-base font-semibold">Agents</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={onRescan}
          disabled={isRefetching}
          data-testid="agents-rescan"
          aria-label="Rescan agents"
        >
          <RefreshCw className={`size-3.5 ${isRefetching ? "animate-spin" : ""}`} />
          Rescan
        </Button>
      </header>

      {isPending && (
        <p className="text-sw-muted text-sm" data-testid="agents-loading">
          Loading…
        </p>
      )}
      {isError && (
        <EmptyState
          data-testid="agents-error"
          title="Couldn't load agents"
          description="The server didn't respond as expected. Check the console for details, or retry shortly."
        />
      )}
      {data && data.length === 0 && (
        <EmptyState
          data-testid="agents-empty"
          icon={<Bot className="size-6" />}
          title="No sub-agent profiles discovered"
          description={
            <span>
              Drop an <code className="font-mono">&lt;name&gt;.md</code> under{" "}
              <code className="font-mono">.agents/agents/</code> in this project, or under{" "}
              <code className="font-mono">~/.agents/agents/</code> for user-scope.
            </span>
          }
        />
      )}
      {data && data.length > 0 && (
        <div className="w-full min-w-0 overflow-x-auto">
          <Table data-testid="agents-table" className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-48">Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-24">Scope</TableHead>
                <TableHead className="w-32">Model</TableHead>
                <TableHead className="w-32">Project</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((a) => (
                <TableRow
                  key={a.locId}
                  data-testid={`agent-row-${a.name}`}
                  data-disabled={a.disabled_reason ? "true" : undefined}
                  className={a.disabled_reason ? "opacity-50" : undefined}
                >
                  <TableCell className="max-w-0 truncate font-medium">
                    <Link
                      to={`/agents/${encodeURIComponent(a.locId)}`}
                      className="transition-colors duration-[var(--sw-duration-hover)] hover:underline"
                      data-testid={`agent-link-${a.name}`}
                    >
                      {a.name}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-0 truncate text-sw-muted" title={a.description}>
                    {a.description}
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-xs text-sw-muted">{a.scope}</code>
                  </TableCell>
                  <TableCell className="max-w-0 truncate" title={a.model ?? "(inherit)"}>
                    <code className="font-mono text-xs text-sw-muted">{a.model ?? "—"}</code>
                  </TableCell>
                  <TableCell className="max-w-0 truncate" title={a.project_cwd ?? "—"}>
                    <code className="font-mono text-xs text-sw-muted">
                      {a.project_cwd ? basename(a.project_cwd) : "—"}
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

function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}
