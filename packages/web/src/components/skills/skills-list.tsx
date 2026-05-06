// Shared skills table — used by /skills (global) and
// /projects/:cwdEnc?tab=skills (per-project). The `projectCwd` prop
// scopes the query; when set, the Project column is dropped because
// every row anchors to the same cwd. `projectOnly` further tightens
// the request to drop user-scope rows entirely — the project detail
// tab uses this so operators only see skills anchored to that
// project root. The Rescan button stays in the caller's header to
// keep this component layout-agnostic.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";
import { Link } from "react-router-dom";
import { queries } from "../../lib/queries.ts";
import { EmptyState } from "../ui/empty-state.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table.tsx";

export interface SkillsListProps {
  /** When set, the list is scoped to globals + this one project's
   * project-scope records. Drops the Project column. */
  projectCwd?: string;
  /** When true (and `projectCwd` is set), drop user-scope records so
   * the response only contains skills anchored to that project. */
  projectOnly?: boolean;
  /** Test/observability anchor. Defaults to "skills-list". */
  testIdPrefix?: string;
}

export function SkillsList({ projectCwd, projectOnly, testIdPrefix = "skills-list" }: SkillsListProps): JSX.Element {
  const { data, isPending, isError } = useQuery(queries.skills.list(projectCwd, projectOnly));

  if (isPending) {
    return (
      <p className="text-sw-muted text-sm" data-testid={`${testIdPrefix}-loading`}>
        Loading…
      </p>
    );
  }
  if (isError) {
    return (
      <EmptyState
        data-testid={`${testIdPrefix}-error`}
        title="Couldn't load skills"
        description="The server didn't respond as expected. Check the console for details, or retry shortly."
      />
    );
  }
  if (data.length === 0) {
    return (
      <EmptyState
        data-testid={`${testIdPrefix}-empty`}
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
    );
  }

  const showProjectCol = projectCwd === undefined;

  return (
    <div className="w-full min-w-0 overflow-x-auto">
      <Table data-testid={`${testIdPrefix}-table`} className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-48">Name</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="w-24">Scope</TableHead>
            {showProjectCol && <TableHead className="w-40">Project</TableHead>}
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
              {showProjectCol && (
                <TableCell className="max-w-0 truncate" title={s.project_cwd ?? "—"}>
                  <code className="font-mono text-xs text-sw-muted">
                    {s.project_cwd ? basename(s.project_cwd) : "—"}
                  </code>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function useSkillsRescan(): () => void {
  const qc = useQueryClient();
  return (): void => {
    qc.invalidateQueries({ queryKey: queries.skills.all() });
  };
}

function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}
