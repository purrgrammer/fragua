// Shared agents table — used by /agents (global) and
// /projects/:cwdEnc?tab=agents (per-project). Mirrors `SkillsList`'s
// shape; the Project column drops when `projectCwd` is set.
// `projectOnly` further tightens the request to drop user-scope rows
// entirely — the project detail tab uses this so operators only see
// profiles anchored to that project root.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { Link } from "react-router-dom";
import { queries } from "../../lib/queries.ts";
import { EmptyState } from "../ui/empty-state.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table.tsx";

export interface AgentsListProps {
  projectCwd?: string;
  /** When true (and `projectCwd` is set), drop user-scope records so
   * the response only contains profiles anchored to that project. */
  projectOnly?: boolean;
  testIdPrefix?: string;
  compact?: boolean;
}

export function AgentsList({
  projectCwd,
  projectOnly,
  testIdPrefix = "agents-list",
  compact = false,
}: AgentsListProps): JSX.Element {
  const { data, isPending, isError } = useQuery(queries.agents.list(projectCwd, projectOnly));

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
        title="Couldn't load agents"
        description="The server didn't respond as expected. Check the console for details, or retry shortly."
      />
    );
  }
  if (data.length === 0) {
    return (
      <EmptyState
        data-testid={`${testIdPrefix}-empty`}
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
    );
  }

  const showModelCol = !compact;
  const showProjectCol = !compact && projectCwd === undefined;

  return (
    <div className="w-full min-w-0 overflow-x-auto">
      <Table data-testid={`${testIdPrefix}-table`} className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-48">Name</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="w-24">Scope</TableHead>
            {showModelCol && <TableHead className="w-32">Model</TableHead>}
            {showProjectCol && <TableHead className="w-32">Project</TableHead>}
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
              {showModelCol && (
                <TableCell className="max-w-0 truncate" title={a.model ?? "(inherit)"}>
                  <code className="font-mono text-xs text-sw-muted">{a.model ?? "—"}</code>
                </TableCell>
              )}
              {showProjectCol && (
                <TableCell className="max-w-0 truncate" title={a.project_cwd ?? "—"}>
                  <code className="font-mono text-xs text-sw-muted">
                    {a.project_cwd ? basename(a.project_cwd) : "—"}
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

export function useAgentsRescan(): () => void {
  const qc = useQueryClient();
  return (): void => {
    qc.invalidateQueries({ queryKey: queries.agents.all() });
  };
}

function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}
