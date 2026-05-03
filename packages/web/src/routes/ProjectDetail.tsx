// /projects/:cwdEnc — runs + workflows filtered to one project root.
//
// `cwdEnc` is the base64url encoding of the absolute path (see
// `lib/projectId.ts`) so paths with `/` survive as a single segment.
// Decoded value is the wire identity sent back to `GET /runs?cwd=`; the
// server does an exact match against `run_state.cwd`. The workflows
// section reuses the global `/workflows` listing and filters
// client-side on `w.cwd === cwd` — the multi-source reader already tags
// each row with its owning project, so no per-project endpoint is
// needed.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { RunRow } from "../components/RunRow.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import { decodeProjectId } from "../lib/projectId.ts";
import { queries } from "../lib/queries.ts";

export function ProjectDetail(): JSX.Element {
  const { cwdEnc = "" } = useParams();
  const cwd = useMemo(() => decodeProjectId(cwdEnc), [cwdEnc]);

  const filter = useMemo(() => (cwd ? { cwd } : undefined), [cwd]);
  const { data: rows, isPending, isError, error } = useQuery({ ...queries.runs.list(filter), enabled: cwd !== null });

  const { data: allWorkflows, error: workflowsError } = useQuery({
    ...queries.workflows.list(),
    enabled: cwd !== null,
  });
  const projectWorkflows = useMemo(
    () => (cwd && allWorkflows ? allWorkflows.filter((w) => w.cwd === cwd) : []),
    [cwd, allWorkflows],
  );

  useEffect(() => {
    if (error)
      console.warn("[ProjectDetail] failed to load runs —", error instanceof Error ? error.message : String(error));
    if (workflowsError)
      console.warn(
        "[ProjectDetail] failed to load workflows —",
        workflowsError instanceof Error ? workflowsError.message : String(workflowsError),
      );
  }, [error, workflowsError]);

  if (cwd === null) {
    return (
      <EmptyState
        data-testid="project-detail-bad-id"
        title="Invalid project link"
        description={
          <span>
            Couldn't decode that path.{" "}
            <Link to="/projects" className="underline">
              Back to projects
            </Link>
            .
          </span>
        }
      />
    );
  }

  const name = basename(cwd);

  return (
    <section className="flex w-full min-w-0 flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="font-heading text-base font-semibold" data-testid="project-detail-name">
          {name}
        </h2>
        <code className="block truncate font-mono text-xs text-sw-muted" title={cwd}>
          {cwd}
        </code>
      </header>

      {projectWorkflows.length > 0 && (
        <section className="flex w-full min-w-0 flex-col gap-2" data-testid="project-workflows-section">
          <h3 className="text-sw-sm font-medium text-sw-muted">Workflows</h3>
          <div className="w-full min-w-0 overflow-x-auto">
            <Table data-testid="project-workflows-table" className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-56">Name</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead className="w-24">SHA</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projectWorkflows.map((w) => (
                  <TableRow key={w.path} data-testid={`project-workflow-row-${w.name}`}>
                    <TableCell className="max-w-0 truncate font-medium" title={w.label ?? w.name}>
                      <Link
                        to={`/workflows/${encodeURIComponent(w.name)}?cwd=${encodeURIComponent(w.cwd ?? "")}`}
                        className="transition-colors duration-[var(--sw-duration-hover)] hover:underline"
                        data-testid={`project-workflow-link-${w.name}`}
                      >
                        {w.label ?? w.name}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-0">
                      <code className="block truncate font-mono text-xs text-sw-muted" title={w.path}>
                        {w.path}
                      </code>
                    </TableCell>
                    <TableCell>
                      <code className="font-mono text-xs" title={w.sha}>
                        {shortSha(w.sha)}
                      </code>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {isPending && (
        <p className="text-sw-muted text-sm" data-testid="project-runs-loading">
          Loading…
        </p>
      )}
      {isError && (
        <EmptyState
          data-testid="project-runs-error"
          title="Couldn't load runs"
          description="The server didn't respond as expected. Check the console for details, or retry shortly."
        />
      )}
      {rows && rows.length === 0 && (
        <EmptyState
          data-testid="project-runs-empty"
          title="No runs in this project yet"
          description={
            <span>
              Runs enqueued from <code className="font-mono">{cwd}</code> show up here.
            </span>
          }
        />
      )}
      {rows && rows.length > 0 && (
        <div className="w-full min-w-0 overflow-x-auto">
          <table className="w-full table-fixed border-collapse" data-testid="project-runs-table">
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

function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}
