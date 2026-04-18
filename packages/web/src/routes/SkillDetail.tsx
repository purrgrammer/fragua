// /skills/:name — full SKILL.md body + metadata + "used in" recent runs.
//
// The "used in" panel only lists runs where the model actually called
// `local:load_skill` (or a parent pre-loaded the skill via `preload_skills`
// on `local:subagent`). Catalog-only advertisements don't count — see
// `skillActivationsProjection` in @swarm/events.

import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge } from "../components/ui/badge.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { type ApiClient, ApiError, type SkillDetail as SkillDetailShape } from "../lib/api.ts";

export interface SkillDetailRouteProps {
  api: ApiClient;
  /** Test injection. */
  fetcher?: (name: string) => Promise<SkillDetailShape>;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; skill: SkillDetailShape }
  | { kind: "not_found" }
  | { kind: "error" };

export function SkillDetail({ api, fetcher }: SkillDetailRouteProps): JSX.Element {
  const { name = "" } = useParams<{ name: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    if (!name) {
      setState({ kind: "not_found" });
      return;
    }
    const load = fetcher ?? ((n: string) => api.getSkill(n));
    load(name)
      .then((skill) => {
        if (!cancelled) setState({ kind: "ready", skill });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setState({ kind: "not_found" });
          return;
        }
        console.warn("[SkillDetail] load failed —", err instanceof Error ? err.message : String(err));
        setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [api, fetcher, name]);

  return (
    <section className="flex w-full min-w-0 flex-col gap-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link to="/skills" className="inline-flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="size-4" />
          <span>Skills</span>
        </Link>
      </div>

      {state.kind === "loading" && (
        <p className="text-muted-foreground text-sm" data-testid="skill-loading">
          Loading…
        </p>
      )}
      {state.kind === "not_found" && (
        <EmptyState
          data-testid="skill-not-found"
          title="Skill not found"
          description={`No skill named "${name}" is installed.`}
        />
      )}
      {state.kind === "error" && (
        <EmptyState
          data-testid="skill-error"
          title="Couldn't load skill"
          description="The server didn't respond as expected. Check the console for details."
        />
      )}
      {state.kind === "ready" && <Detail skill={state.skill} />}
    </section>
  );
}

function Detail({ skill }: { skill: SkillDetailShape }): JSX.Element {
  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="font-heading text-lg font-semibold">{skill.name}</h2>
        <p className="text-sm text-muted-foreground">{skill.description}</p>
        <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
          <Badge variant={skill.scope === "project" ? "default" : "secondary"}>{skill.scope}</Badge>
          {skill.version && <span className="font-mono">v{skill.version}</span>}
          <code className="truncate font-mono" title={skill.location}>
            {skill.location}
          </code>
        </div>
        {skill.disabled_reason && (
          <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Hidden from the agent catalog: {skill.disabled_reason}
          </p>
        )}
      </header>

      <div className="flex flex-col gap-2 md:flex-row md:gap-6">
        <aside className="flex w-full shrink-0 flex-col gap-3 md:w-56" data-testid="skill-sidebar">
          <Metadata label="Bytes">{skill.bytes.toLocaleString()}</Metadata>
          <Metadata label="SHA256">
            <code className="font-mono text-xs" title={skill.sha256}>
              {skill.sha256.slice(0, 12)}…
            </code>
          </Metadata>
          {skill.allowed_tools && skill.allowed_tools.length > 0 && (
            <Metadata label="Allowed tools">
              <ul className="space-y-0.5">
                {skill.allowed_tools.map((t) => (
                  <li key={t}>
                    <code className="font-mono text-xs">{t}</code>
                  </li>
                ))}
              </ul>
            </Metadata>
          )}
          {skill.usage && (
            <Metadata label="Used in recent runs">
              {skill.usage.runs.length === 0 ? (
                <span className="text-muted-foreground">No recent activations</span>
              ) : (
                <ul className="space-y-0.5" data-testid="skill-usage-runs">
                  {skill.usage.runs.map((runId) => (
                    <li key={runId}>
                      <Link
                        to={`/pipelines/${encodeURIComponent(runId)}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {runId}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <span className="mt-1 block text-xs text-muted-foreground">{skill.usage.count} total activations</span>
            </Metadata>
          )}
        </aside>

        <article
          className="min-w-0 flex-1 whitespace-pre-wrap rounded border bg-muted/30 p-4 font-mono text-sm"
          data-testid="skill-body"
        >
          {skill.body}
        </article>
      </div>
    </div>
  );
}

function Metadata({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="text-sm">{children}</div>
    </div>
  );
}
