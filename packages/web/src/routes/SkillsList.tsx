// /skills — catalog of installed skills from `GET /skills`.
//
// Columns: Name / Description / Scope / Source. Skills disabled via
// `skills.disabled` / `trust_project: false` in `.swarm/config.yaml` are
// hidden by default (if you turned them off in config, you asked to not
// see them). A "N hidden by config" footer + toggle reveals them — the
// detail page stays reachable via its direct URL either way.

import { BookOpen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../components/ui/badge.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import type { ApiClient, SkillSummary } from "../lib/api.ts";

export interface SkillsListProps {
  api: ApiClient;
  /** Test injection — mirrors Workflows/Home. */
  fetcher?: () => Promise<SkillSummary[]>;
}

type LoadState = { kind: "loading" } | { kind: "ready"; rows: SkillSummary[] } | { kind: "error" };

export function SkillsList({ api, fetcher }: SkillsListProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [showDisabled, setShowDisabled] = useState(false);

  const { visibleRows, hiddenCount } = useMemo(() => {
    if (state.kind !== "ready") return { visibleRows: [] as SkillSummary[], hiddenCount: 0 };
    const hidden = state.rows.filter((r) => r.disabled_reason !== undefined);
    const visible = showDisabled ? state.rows : state.rows.filter((r) => r.disabled_reason === undefined);
    return { visibleRows: visible, hiddenCount: hidden.length };
  }, [state, showDisabled]);

  useEffect(() => {
    let cancelled = false;
    const load = fetcher ?? (() => api.listSkills());
    load()
      .then((rows) => {
        if (!cancelled) setState({ kind: "ready", rows });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn("[Skills] failed to load skills —", err instanceof Error ? err.message : String(err));
        setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [api, fetcher]);

  return (
    <section className="flex w-full min-w-0 flex-col gap-3">
      <h2 className="font-heading text-base font-semibold">Skills</h2>
      {state.kind === "loading" && (
        <p className="text-muted-foreground text-sm" data-testid="skills-loading">
          Loading…
        </p>
      )}
      {state.kind === "error" && (
        <EmptyState
          data-testid="skills-error"
          title="Couldn't load skills"
          description="The server didn't respond as expected. Check the console for details, or retry shortly."
        />
      )}
      {state.kind === "ready" && visibleRows.length === 0 && hiddenCount === 0 && (
        <EmptyState
          data-testid="skills-empty"
          icon={<BookOpen className="size-6" />}
          title="No skills installed"
          description={
            <span>
              Drop a <code className="font-mono">SKILL.md</code> into{" "}
              <code className="font-mono">.agents/skills/&lt;name&gt;/</code> or{" "}
              <code className="font-mono">~/.agents/skills/&lt;name&gt;/</code>.
            </span>
          }
        />
      )}
      {state.kind === "ready" && visibleRows.length === 0 && hiddenCount > 0 && (
        <EmptyState
          data-testid="skills-all-disabled"
          icon={<BookOpen className="size-6" />}
          title="All skills disabled"
          description={`${hiddenCount} skill${hiddenCount === 1 ? "" : "s"} hidden by .swarm/config.yaml.`}
        />
      )}
      {state.kind === "ready" && visibleRows.length > 0 && (
        <div className="w-full min-w-0 overflow-x-auto">
          <Table data-testid="skills-table" className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-56">Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-24">Scope</TableHead>
                <TableHead className="w-40">Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map((row) => {
                const dim = row.disabled_reason !== undefined;
                return (
                  <TableRow
                    key={row.name}
                    data-testid={`skill-row-${row.name}`}
                    data-disabled={dim ? "true" : undefined}
                    className={dim ? "opacity-50" : undefined}
                    title={row.disabled_reason}
                  >
                    <TableCell className="max-w-0 truncate font-medium">
                      <Link to={`/skills/${encodeURIComponent(row.name)}`} className="hover:underline">
                        {row.name}
                      </Link>
                      {row.version && (
                        <span className="ml-2 font-mono text-xs text-muted-foreground">{row.version}</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-0">
                      <span className="block truncate text-sm" title={row.description}>
                        {row.description}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.scope === "project" ? "default" : "secondary"}>{row.scope}</Badge>
                    </TableCell>
                    <TableCell className="max-w-0">
                      <code className="block truncate font-mono text-xs text-muted-foreground" title={row.source_dir}>
                        {row.source_dir}
                      </code>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {state.kind === "ready" && hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowDisabled((v) => !v)}
          data-testid="skills-toggle-disabled"
          className="self-start text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        >
          {showDisabled
            ? `Hide ${hiddenCount} disabled`
            : `Show ${hiddenCount} disabled skill${hiddenCount === 1 ? "" : "s"}`}
        </button>
      )}
    </section>
  );
}
