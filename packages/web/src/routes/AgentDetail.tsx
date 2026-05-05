// /agents/:locId — read-only sub-agent profile detail. Header (name,
// description, scope, source, model, provider, allowed_tools, sha) +
// the prompt body, rendered as markdown with a Raw/Rendered toggle.
// The body is what the sub-agent receives verbatim as its system
// prompt on spawn (when no inline override is passed) — the raw view
// is genuinely useful for "what does the agent actually see."

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Streamdown } from "streamdown";
import { Button } from "../components/ui/button.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import type { AgentSummary } from "../lib/api.ts";
import { queries } from "../lib/queries.ts";

export function AgentDetail(): JSX.Element {
  const { locId: rawLocId } = useParams<{ locId: string }>();
  const locId = rawLocId ?? "";
  const detail = useQuery({ ...queries.agents.detail(locId), enabled: locId.length > 0 });
  const [mode, setMode] = useState<"rendered" | "raw">("rendered");

  if (detail.isPending) {
    return (
      <p className="text-sm text-sw-muted" data-testid="agent-detail-loading">
        Loading…
      </p>
    );
  }
  if (detail.isError) {
    return (
      <EmptyState
        data-testid="agent-detail-error"
        title="Couldn't load agent"
        description="The server didn't respond as expected. Check the console for details, or retry shortly."
      />
    );
  }
  const agent = detail.data.agent;

  return (
    <section className="flex w-full min-w-0 flex-col gap-4" data-testid="agent-detail">
      <Header agent={agent} />
      <div className="flex min-h-0 flex-1 flex-col rounded-md border border-sw-border bg-sw-surface">
        <div className="flex items-center justify-between border-b border-sw-border px-4 py-2">
          <span className="font-mono text-xs text-sw-muted">prompt body (sub-agent system prompt)</span>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={mode === "rendered" ? "default" : "outline"}
              onClick={() => setMode("rendered")}
              data-testid="agent-detail-mode-rendered"
              data-active={mode === "rendered" ? "true" : undefined}
            >
              Rendered
            </Button>
            <Button
              size="sm"
              variant={mode === "raw" ? "default" : "outline"}
              onClick={() => setMode("raw")}
              data-testid="agent-detail-mode-raw"
              data-active={mode === "raw" ? "true" : undefined}
            >
              Raw
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {mode === "rendered" ? (
            <div data-testid="agent-detail-body-rendered">
              <Streamdown className="prose prose-sm max-w-none prose-pre:bg-sw-surface-2 prose-pre:text-sw-text">
                {detail.data.body}
              </Streamdown>
            </div>
          ) : (
            <pre className="font-mono text-xs text-sw-text" data-testid="agent-detail-body-raw">
              {detail.data.body}
            </pre>
          )}
        </div>
      </div>
    </section>
  );
}

function Header({ agent }: { agent: AgentSummary }): JSX.Element {
  const fields = useMemo(
    () =>
      (
        [
          ["scope", agent.scope],
          ["source", agent.source_dir],
          ["project", agent.project_cwd ?? "—"],
          ["bytes", String(agent.bytes)],
          ["sha256", shortSha(agent.sha256)],
          ["model", agent.model ?? "—"],
          ["provider", agent.provider ?? "—"],
          ["allowed_tools", agent.allowed_tools?.length ? agent.allowed_tools.join(", ") : "—"],
        ] as const
      ).filter(([, v]) => v !== "" && v !== undefined),
    [agent],
  );
  return (
    <header className="flex flex-col gap-2 rounded-md border border-sw-border bg-sw-surface p-4">
      <div className="flex items-baseline gap-3">
        <h2 className="font-heading text-lg font-semibold" data-testid="agent-detail-name">
          {agent.name}
        </h2>
        {agent.disabled_reason && (
          <span
            className="rounded bg-sw-surface-2 px-2 py-0.5 font-mono text-xs text-sw-muted"
            data-testid="agent-detail-disabled"
            title={agent.disabled_reason}
          >
            disabled: {agent.disabled_reason}
          </span>
        )}
      </div>
      <p className="text-sm text-sw-text" data-testid="agent-detail-description">
        {agent.description}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-sw-muted lg:grid-cols-3">
        {fields.map(([k, v]) => (
          <div key={k} className="flex gap-2 truncate">
            <dt className="shrink-0">{k}:</dt>
            <dd className="truncate" title={String(v)}>
              {String(v)}
            </dd>
          </div>
        ))}
      </dl>
    </header>
  );
}

function shortSha(sha: string): string {
  return sha.length > 12 ? `${sha.slice(0, 12)}…` : sha;
}
