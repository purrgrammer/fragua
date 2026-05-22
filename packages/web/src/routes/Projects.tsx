// /projects — one row per distinct `run_state.cwd`.
//
// A "project" is just a project root the daemon has ever seen a run from
// (the harness-by-default model — there is no separate registration
// table). Display name is the basename of the path; the wire identity
// stays the full absolute path so two checkouts of the same repo at
// different paths don't collide.
//
// Columns: Name (basename, link to detail) / Path (truncated, full
// path on hover) / Runs / Last Activity (relative time).

import { useQuery } from "@tanstack/react-query";
import { FolderGit2 } from "lucide-react";
import { useEffect } from "react";
import { ProjectLink } from "../components/ProjectLink.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import { queries } from "../lib/queries.ts";
import { formatRelative } from "../lib/time.ts";

export function Projects(): JSX.Element {
  const { data: rows, isPending, isError, error } = useQuery(queries.projects.list());

  useEffect(() => {
    if (error)
      console.warn("[Projects] failed to load projects —", error instanceof Error ? error.message : String(error));
  }, [error]);

  return (
    <section className="flex w-full min-w-0 flex-col gap-3">
      <h2 className="font-heading text-base font-semibold">Projects</h2>
      {isPending && (
        <p className="text-sw-muted text-sm" data-testid="projects-loading">
          Loading…
        </p>
      )}
      {isError && (
        <EmptyState
          data-testid="projects-error"
          title="Couldn't load projects"
          description="The server didn't respond as expected. Check the console for details, or retry shortly."
        />
      )}
      {rows && rows.length === 0 && (
        <EmptyState
          data-testid="projects-empty"
          icon={<FolderGit2 className="size-6 text-sw-muted" aria-hidden />}
          title="No projects yet"
          description={
            <span>
              Run <code className="font-mono">fragua run</code> from any project root to surface it here.
            </span>
          }
        />
      )}
      {rows && rows.length > 0 && (
        <div className="w-full min-w-0 overflow-x-auto">
          <Table data-testid="projects-table" className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-56">Name</TableHead>
                <TableHead>Path</TableHead>
                <TableHead className="w-20 text-right">Runs</TableHead>
                <TableHead className="w-40 text-right">Last activity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.projectId} data-testid={`project-row-${row.name}`}>
                  <TableCell className="max-w-0 truncate font-medium" title={row.name}>
                    <ProjectLink
                      projectId={row.projectId}
                      name={row.name}
                      variant="plain"
                      className="transition-colors duration-[var(--sw-duration-hover)] hover:underline"
                      data-testid={`project-link-${row.name}`}
                    >
                      {row.name}
                    </ProjectLink>
                  </TableCell>
                  <TableCell className="max-w-0">
                    <code
                      className="block truncate font-mono text-xs text-sw-muted"
                      title={row.cwd ?? "Not checked out locally"}
                    >
                      {row.cwd ?? "—"}
                    </code>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.runCount}</TableCell>
                  <TableCell className="text-right text-sw-muted">{formatRelative(row.lastUpdatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
