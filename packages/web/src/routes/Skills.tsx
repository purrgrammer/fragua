// /skills — discovery view across globals + every cwd in run_state.
// Read-only; click a row to open the detail view (metadata header +
// file tree + on-demand file viewer). Rescan invalidates the
// `["skills","list",…]` cache and re-walks the filesystem on the
// server side.
//
// `?project_cwd=<cwd>` scopes the list to globals + that one project's
// project-scope records, matching what a run in that cwd actually
// sees at codergen time. Without it, every project's records appear
// — distinguished by the Project column.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, RefreshCw } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "../components/ui/button.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import { queries } from "../lib/queries.ts";

export function Skills(): JSX.Element {
  const [searchParams] = useSearchParams();
  const projectCwd = searchParams.get("project_cwd") ?? undefined;
  const { data, isPending, isError, refetch, isRefetching } = useQuery(queries.skills.list(projectCwd));
  const qc = useQueryClient();

  const onRescan = (): void => {
    qc.invalidateQueries({ queryKey: queries.skills.all() });
    void refetch();
  };

  return (
    <section className="flex w-full min-w-0 flex-col gap-3">
      <header className="flex items-center justify-between">
        <h2 className="font-heading text-base font-semibold">Skills</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={onRescan}
          disabled={isRefetching}
          data-testid="skills-rescan"
          aria-label="Rescan skills"
        >
          <RefreshCw className={`size-3.5 ${isRefetching ? "animate-spin" : ""}`} />
          Rescan
        </Button>
      </header>

      {isPending && (
        <p className="text-sw-muted text-sm" data-testid="skills-loading">
          Loading…
        </p>
      )}
      {isError && (
        <EmptyState
          data-testid="skills-error"
          title="Couldn't load skills"
          description="The server didn't respond as expected. Check the console for details, or retry shortly."
        />
      )}
      {data && data.length === 0 && (
        <EmptyState
          data-testid="skills-empty"
          icon={<BookOpen className="size-6" />}
          title="No skills discovered"
          description={
            <span>
              Drop a <code className="font-mono">SKILL.md</code> under{" "}
              <code className="font-mono">.agents/skills/&lt;name&gt;/</code> in this project, or under{" "}
              <code className="font-mono">~/.agents/skills/</code> for user-scope.
            </span>
          }
        />
      )}
      {data && data.length > 0 && (
        <div className="w-full min-w-0 overflow-x-auto">
          <Table data-testid="skills-table" className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-48">Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-24">Scope</TableHead>
                <TableHead className="w-40">Project</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((s) => (
                <TableRow
                  key={s.locId}
                  data-testid={`skill-row-${s.name}`}
                  data-disabled={s.disabled_reason ? "true" : undefined}
                  className={s.disabled_reason ? "opacity-50" : undefined}
                >
                  <TableCell className="max-w-0 truncate font-medium">
                    <Link
                      to={`/skills/${encodeURIComponent(s.locId)}`}
                      className="transition-colors duration-[var(--sw-duration-hover)] hover:underline"
                      data-testid={`skill-link-${s.name}`}
                    >
                      {s.name}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-0 truncate text-sw-muted" title={s.description}>
                    {s.description}
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-xs text-sw-muted">{s.scope}</code>
                  </TableCell>
                  <TableCell className="max-w-0 truncate" title={s.project_cwd ?? "—"}>
                    <code className="font-mono text-xs text-sw-muted">
                      {s.project_cwd ? basename(s.project_cwd) : "—"}
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
