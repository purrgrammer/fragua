// Wave 5 — Per-step context inspector. Fetches `StepSnapshot[]` from
// `GET /pipelines/:id/steps` and renders collapsible sections for
// Prompt, System prompt, Messages, Tools, Context files, Settings,
// Budget, Cost. The conversation view (PipelineConversation) stays the
// primary "what happened" surface; this panel answers "what exactly
// did the agent see at step N?" — the question Waves 1–4 captured the
// data to answer but had no UI for.
//
// Design:
//   - Server already folded the event stream into snapshots; the UI
//     does no replay.
//   - Each step renders as a `<details>` with a summary row (node id,
//     model, duration, cost). Expanding reveals the full context. No
//     virtualization yet — 23K-event runs typically produce 10–200
//     steps, well within unoptimised render budgets.
//   - Pure display; no mutation, no state beyond the fetch.

import { useEffect, useState } from "react";
import type { ApiClient, StepSnapshot } from "../lib/api.ts";
import { formatTokensCompact, formatUsd } from "../lib/format.ts";
import { formatDuration } from "../lib/time.ts";

export interface StepInspectorProps {
  api: ApiClient;
  runId: string;
  /** When set, total step count the parent can use for lazy-mount
   * decisions. Re-fetching on totalEvents changes keeps the panel
   * live as the run grows. */
  totalEvents?: number;
}

type FetchState = { kind: "loading" } | { kind: "ready"; steps: StepSnapshot[] } | { kind: "error"; message: string };

export function StepInspector({ api, runId, totalEvents }: StepInspectorProps): JSX.Element {
  const [state, setState] = useState<FetchState>({ kind: "loading" });

  // Refetch on totalEvents transitions so the inspector picks up new
  // steps as they stream in. Cheap: the server replays from disk.
  // biome-ignore lint/correctness/useExhaustiveDependencies: totalEvents is an intentional re-fetch trigger.
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    api
      .getPipelineSteps(runId)
      .then((steps) => {
        if (!cancelled) setState({ kind: "ready", steps });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [api, runId, totalEvents]);

  if (state.kind === "loading") {
    return (
      <div data-testid="step-inspector-loading" className="text-xs text-slate-500 p-4">
        Loading steps…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div data-testid="step-inspector-error" className="text-xs text-rose-600 p-4">
        Failed to load steps.
      </div>
    );
  }
  if (state.steps.length === 0) {
    return (
      <div data-testid="step-inspector-empty" className="text-xs text-slate-500 p-4">
        No agent steps recorded for this run yet.
      </div>
    );
  }

  return (
    <div data-testid="step-inspector" className="flex flex-col gap-2 p-3">
      {state.steps.map((step) => (
        <StepCard key={step.stepIdx} step={step} />
      ))}
    </div>
  );
}

function StepCard({ step }: { step: StepSnapshot }): JSX.Element {
  const headLabel = [
    `#${step.stepIdx}`,
    step.nodeId,
    step.iteration ? `iter ${step.iteration.n}/${step.iteration.max}` : undefined,
    step.model ? `${step.provider ?? "?"} / ${step.model}` : undefined,
    step.fidelity,
  ]
    .filter(Boolean)
    .join(" · ");
  const metrics = [
    step.durationMs !== undefined ? `⏱ ${formatDuration(step.durationMs)}` : undefined,
    step.cost !== undefined ? `💲 ${formatUsd(step.cost.cost_usd)}` : undefined,
    step.cost !== undefined
      ? `◎ ${formatTokensCompact(step.cost.total_tokens ?? step.cost.input_tokens + step.cost.output_tokens)}`
      : undefined,
  ].filter(Boolean);

  return (
    <details data-testid={`step-${step.stepIdx}`} className="border rounded-md bg-card">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm flex items-center gap-3">
        <span className="font-mono text-xs text-muted-foreground flex-shrink-0">{headLabel}</span>
        <span className="ml-auto flex gap-3 text-xs text-muted-foreground tabular-nums">
          {metrics.map((m) => (
            <span key={m}>{m}</span>
          ))}
        </span>
      </summary>
      <div className="flex flex-col gap-3 p-3 text-xs border-t">
        <Section title="Prompt">
          <pre className="whitespace-pre-wrap break-words font-mono bg-muted/50 p-2 rounded text-xs">{step.prompt}</pre>
        </Section>
        <Section title="System prompt">
          <pre className="whitespace-pre-wrap break-words font-mono bg-muted/50 p-2 rounded text-xs">
            {step.systemPrompt}
          </pre>
        </Section>
        {step.messages.length > 0 && (
          <Section title={`Prior messages (${step.messages.length})`}>
            <ul className="flex flex-col gap-1">
              {step.messages.map((m, i) => (
                <li key={`${m.role}-${i}`} className="font-mono text-xs">
                  <span className="text-muted-foreground">[{m.role}]</span> {messagePreview(m.content)}
                </li>
              ))}
            </ul>
          </Section>
        )}
        {(step.allowedTools.length > 0 || step.deniedTools.length > 0) && (
          <Section title="Tools">
            {step.allowedTools.length > 0 && (
              <div>
                <span className="text-muted-foreground">allowed:</span> {step.allowedTools.join(", ")}
              </div>
            )}
            {step.deniedTools.length > 0 && (
              <div>
                <span className="text-muted-foreground">denied:</span> {step.deniedTools.join(", ")}
              </div>
            )}
          </Section>
        )}
        {step.contextFiles.length > 0 && (
          <Section title="Context files">
            <ul className="flex flex-col gap-1">
              {step.contextFiles.map((f) => (
                <li key={f.path} className="font-mono text-xs flex items-center gap-2">
                  <span>{f.path}</span>
                  <span className="text-muted-foreground">{f.bytes}B</span>
                  {f.truncated && <span className="text-amber-600">truncated</span>}
                  {f.status === "missing" && <span className="text-rose-600">missing</span>}
                  <span className="text-muted-foreground">{f.sha256.slice(0, 12)}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {step.skills && step.skills.length > 0 && (
          <Section title={`Skills catalog (${step.skills.length})`}>
            <ul data-testid={`step-${step.stepIdx}-skills`} className="flex flex-col gap-1">
              {step.skills.map((s) => (
                <li key={s.name} className="font-mono text-xs flex items-center gap-2">
                  <a href={`/skills/${encodeURIComponent(s.name)}`} className="hover:underline">
                    {s.name}
                  </a>
                  <span className="text-muted-foreground">{s.scope}</span>
                  <span className="text-muted-foreground">{s.bytes}B</span>
                  <span className="text-muted-foreground">{s.sha256.slice(0, 12)}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {step.settings && Object.keys(step.settings).length > 0 && (
          <Section title="Settings">
            <pre className="whitespace-pre-wrap font-mono text-xs">{JSON.stringify(step.settings, null, 2)}</pre>
          </Section>
        )}
        {step.budget && (
          <Section title="Budget">
            <div className="flex flex-col gap-0.5 font-mono text-xs">
              <div>
                spent: {formatUsd(step.budget.cumulative_cost_usd)} /{" "}
                {step.budget.max_cost_usd !== undefined ? formatUsd(step.budget.max_cost_usd) : "—"} (node)
              </div>
              <div>
                tokens: {step.budget.cumulative_tokens}
                {step.budget.run_max_cost_usd !== undefined
                  ? ` · run cap ${formatUsd(step.budget.run_max_cost_usd)}`
                  : ""}
              </div>
            </div>
          </Section>
        )}
        {step.finalText && (
          <Section title="Final assistant text">
            <pre className="whitespace-pre-wrap break-words font-mono bg-muted/50 p-2 rounded text-xs">
              {step.finalText}
            </pre>
          </Section>
        )}
      </div>
    </details>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[0.7rem] uppercase tracking-wider text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function messagePreview(content: unknown): string {
  if (typeof content === "string") return content.length > 200 ? `${content.slice(0, 197)}…` : content;
  if (Array.isArray(content)) {
    const text = content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") {
          const o = c as { type?: unknown; text?: unknown };
          if (typeof o.text === "string") return o.text;
          if (typeof o.type === "string") return `<${o.type}>`;
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
    return text.length > 200 ? `${text.slice(0, 197)}…` : text;
  }
  return content === undefined ? "" : JSON.stringify(content).slice(0, 200);
}
