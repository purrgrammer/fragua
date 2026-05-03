// /projects/:cwdEnc — runs filtered to one project root.
//
// `cwdEnc` is the base64url encoding of the absolute path (see
// `lib/projectId.ts`) so paths with `/` survive as a single segment.
// Decoded value is the wire identity sent back to `GET /runs?cwd=`; the
// server does an exact match against `run_state.cwd`.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { RunRow } from "../components/RunRow.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { decodeProjectId } from "../lib/projectId.ts";
import { queries } from "../lib/queries.ts";

export function ProjectDetail(): JSX.Element {
  const { cwdEnc = "" } = useParams();
  const cwd = useMemo(() => decodeProjectId(cwdEnc), [cwdEnc]);

  const filter = useMemo(() => (cwd ? { cwd } : undefined), [cwd]);
  const { data: rows, isPending, isError, error } = useQuery({ ...queries.runs.list(filter), enabled: cwd !== null });

  useEffect(() => {
    if (error)
      console.warn("[ProjectDetail] failed to load runs —", error instanceof Error ? error.message : String(error));
  }, [error]);

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
