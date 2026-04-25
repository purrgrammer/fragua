// Per-step context inspector. Fetches `StepSnapshot[]` from
// `GET /runs/:id/steps` and renders collapsible sections for
// Prompt, System prompt, Messages, Tools, Context files, Settings,
// Budget, Cost. The conversation view (RunConversation) stays the
// primary "what happened" surface; this panel answers "what exactly
// did the agent see at step N?".
//
// Design:
//   - Server already folded the event stream into snapshots; the UI
//     does no replay.
//   - Each step renders as a `<details>` with a summary row (node id,
//     model, duration, cost). Expanding reveals the full context. No
//     virtualization yet — 23K-event runs typically produce 10–200
//     steps, well within unoptimised render budgets.
//   - Pure display; no mutation, no state beyond the fetch.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect } from "react";
import { getProvider, getRunSteps, type ProviderModel, type StepSnapshot } from "../lib/api.ts";
import { tokensCompactFormatOptions, usdFormatOptions } from "../lib/format.ts";
import { formatDuration } from "../lib/time.ts";
import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextTrigger,
} from "./ai-elements/context.tsx";
import { AnimatedNumber } from "./ui/animated-number.tsx";

export interface StepInspectorProps {
  runId: string;
  /** When set, total step count the parent can use for lazy-mount
   * decisions. Re-fetching on totalEvents changes keeps the panel
   * live as the run grows. */
  totalEvents?: number;
}

export function StepInspector({ runId, totalEvents }: StepInspectorProps): JSX.Element {
  const qc = useQueryClient();
  const queryKey = ["runs", "steps", runId] as const;
  const {
    data: steps,
    isPending,
    isError,
  } = useQuery({
    queryKey,
    queryFn: () => getRunSteps(runId),
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: totalEvents is the intentional trigger; qc and queryKey are stable.
  useEffect(() => {
    if (totalEvents !== undefined) void qc.invalidateQueries({ queryKey });
  }, [totalEvents]);

  if (isPending) {
    return (
      <div data-testid="step-inspector-loading" className="text-xs text-slate-500 p-4">
        Loading steps…
      </div>
    );
  }
  if (isError) {
    return (
      <div data-testid="step-inspector-error" className="text-xs text-rose-600 p-4">
        Failed to load steps.
      </div>
    );
  }
  if (!steps || steps.length === 0) {
    return (
      <div data-testid="step-inspector-empty" className="text-xs text-slate-500 p-4">
        No agent steps recorded for this run yet.
      </div>
    );
  }

  return (
    <div data-testid="step-inspector" className="flex flex-col gap-2 p-3">
      {steps.map((step) => (
        <StepCard key={step.stepIdx} step={step} />
      ))}
    </div>
  );
}

/**
 * Look up the context-window size for a given provider+model pair.
 * Returns `undefined` while loading or when the provider is unknown.
 */
function useContextWindow(provider: string | undefined, modelId: string | undefined): number | undefined {
  const { data: providerDetail } = useQuery({
    queryKey: ["providers", provider] as const,
    queryFn: () => getProvider(provider!),
    enabled: !!provider,
    // Provider metadata rarely changes; stale for 10 min.
    staleTime: 10 * 60 * 1000,
  });
  if (!providerDetail || !modelId) return undefined;
  const found: ProviderModel | undefined = providerDetail.models.find((m) => m.id === modelId);
  return found?.contextWindow;
}

function StepCard({ step }: { step: StepSnapshot }): JSX.Element {
  const contextWindow = useContextWindow(step.provider, step.model);

  const headLabel = [
    `#${step.stepIdx}`,
    step.nodeId,
    step.iteration ? `iter ${step.iteration.n}/${step.iteration.max}` : undefined,
    step.model ? `${step.provider ?? "?"} / ${step.model}` : undefined,
    step.fidelity,
  ]
    .filter(Boolean)
    .join(" · ");

  // Summary row still shows duration — cost/token details move into the
  // Context card inside the expanded body.
  const metrics: { key: string; node: ReactNode }[] = [];
  if (step.durationMs !== undefined) {
    metrics.push({ key: "duration", node: <>⏱ {formatDuration(step.durationMs)}</> });
  }
  if (step.cost !== undefined) {
    metrics.push({
      key: "cost",
      node: (
        <>
          💲 <AnimatedNumber value={step.cost.cost_usd} format={usdFormatOptions(step.cost.cost_usd)} />
        </>
      ),
    });
  }

  // Build LanguageModelUsage for the Context component.
  const inputTokens = step.cost?.input_tokens ?? 0;
  const outputTokens = step.cost?.output_tokens ?? 0;
  const cacheReadTokens = step.cost?.cache_read_tokens ?? 0;
  const totalTokens = step.cost !== undefined ? (step.cost.total_tokens ?? inputTokens + outputTokens) : 0;

  // usedTokens for the context ring: total tokens sent to the model (input + cache reads).
  // cache_read_tokens count against the context window just like fresh input.
  const usedTokens = totalTokens || inputTokens + cacheReadTokens || 1;
  // If we have a known context window, use it; otherwise use usedTokens so the
  // ring shows 100% (informational, not misleading about capacity).
  const maxTokens = contextWindow && contextWindow > 0 ? contextWindow : usedTokens || 1;

  // modelId for tokenlens cost calculation (format: "provider:modelId").
  const tokenlensModelId = step.provider && step.model ? `${step.provider}:${step.model}` : undefined;

  // Stop the click from toggling the <details> element when interacting with the popover trigger.
  const stopDetailsPropagation = useCallback((e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
  }, []);

  // Show the context circle whenever we have any token data recorded for this step.
  // hasContextWindow controls whether the ring shows a meaningful fraction or just 100%.
  const showContextCircle = step.cost !== undefined && (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0);

  return (
    <details data-testid={`step-${step.stepIdx}`} className="border rounded-md bg-card">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm flex items-center gap-3">
        <span className="font-mono text-xs text-muted-foreground flex-shrink-0">{headLabel}</span>
        <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
          {metrics.map((m) => (
            <span key={m.key}>{m.node}</span>
          ))}
          {showContextCircle && (
            // biome-ignore lint/a11y/noStaticElementInteractions: stop <details> toggle when interacting with the popover trigger
            <span onClick={stopDetailsPropagation} onKeyDown={stopDetailsPropagation}>
              <Context
                maxTokens={maxTokens}
                usedTokens={usedTokens}
                usage={{
                  inputTokens,
                  outputTokens,
                  cachedInputTokens: cacheReadTokens,
                  reasoningTokens: 0,
                  totalTokens,
                  inputTokenDetails: {
                    noCacheTokens: inputTokens,
                    cacheReadTokens,
                    cacheWriteTokens: step.cost?.cache_write_tokens ?? 0,
                  },
                  outputTokenDetails: {
                    textTokens: outputTokens,
                    reasoningTokens: 0,
                  },
                }}
                modelId={tokenlensModelId}
              >
                <ContextTrigger className="h-auto p-0 text-xs" />
                <ContextContent>
                  <ContextContentHeader />
                  <ContextContentBody>
                    <ContextInputUsage />
                    <ContextOutputUsage />
                    <ContextCacheUsage />
                  </ContextContentBody>
                  <ContextContentFooter>
                    <span className="text-muted-foreground">Total cost</span>
                    <span>
                      {step.cost !== undefined ? (
                        <AnimatedNumber value={step.cost.cost_usd} format={usdFormatOptions(step.cost.cost_usd)} />
                      ) : (
                        "—"
                      )}
                    </span>
                  </ContextContentFooter>
                </ContextContent>
              </Context>
            </span>
          )}
        </span>
      </summary>
      <div className="flex flex-col gap-3 p-3 text-xs border-t">
        <Section title="Prompt">
          <pre className="whitespace-pre-wrap break-words font-mono bg-muted/50 p-2 rounded text-xs">{step.prompt}</pre>
        </Section>
        {step.systemPrompt && (
          <Section title="System prompt">
            <pre className="whitespace-pre-wrap break-words font-mono bg-muted/50 p-2 rounded text-xs">
              {step.systemPrompt}
            </pre>
          </Section>
        )}
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
                spent:{" "}
                <AnimatedNumber
                  value={step.budget.cumulative_cost_usd}
                  format={usdFormatOptions(step.budget.cumulative_cost_usd)}
                />{" "}
                /{" "}
                {step.budget.max_cost_usd !== undefined ? (
                  <AnimatedNumber
                    value={step.budget.max_cost_usd}
                    format={usdFormatOptions(step.budget.max_cost_usd)}
                  />
                ) : (
                  "—"
                )}{" "}
                (node)
              </div>
              <div>
                tokens:{" "}
                <AnimatedNumber
                  value={step.budget.cumulative_tokens}
                  format={tokensCompactFormatOptions(step.budget.cumulative_tokens)}
                />
                {step.budget.run_max_cost_usd !== undefined ? (
                  <>
                    {" · run cap "}
                    <AnimatedNumber
                      value={step.budget.run_max_cost_usd}
                      format={usdFormatOptions(step.budget.run_max_cost_usd)}
                    />
                  </>
                ) : null}
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
