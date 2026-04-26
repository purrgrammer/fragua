// Per-LLM-call cost + context inspector. Fetches `StepSnapshot[]` from
// `GET /runs/:id/steps` and renders one row per call: node id, model,
// duration, total $, and a click-to-open ring with the input / output /
// cache token + cost breakdown.
//
// The "Steps" tab used to dump the full step context (prompt, system
// prompt, prior messages, tools, context files, settings, budget,
// final assistant text). All of that already lives in the Conversation
// tab and is reachable via the messages table; duplicating it here just
// made the page noisy. The remaining purpose is auditing spend per call.
//
// Design:
//   - Server merges `eventsToSteps` + SQL cost aggregates; the UI does
//     no replay or numerical folding.
//   - Per-row cost breakdown is computed from the `ProviderModel` rate
//     card (USD per million tokens). `tokenlens` doesn't recognise
//     custom providers (e.g. `ppq:`) and would render every line as
//     `$0.00`.
//   - Cache reads carry no `$` line — cached pricing is a discount on
//     fresh input, not a separate cost bucket.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { getProvider, getRunSteps, type ProviderModel, type StepSnapshot } from "../lib/api.ts";
import { formatTokensCompact, formatUsd, usdFormatOptions } from "../lib/format.ts";
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

export interface CostInspectorProps {
  runId: string;
  /** When set, total step count the parent can use for lazy-mount
   * decisions. Re-fetching on totalEvents changes keeps the panel
   * live as the run grows. */
  totalEvents?: number;
}

export function CostInspector({ runId, totalEvents }: CostInspectorProps): JSX.Element {
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
      <div data-testid="cost-inspector-loading" className="text-xs text-slate-500 p-4">
        Loading…
      </div>
    );
  }
  if (isError) {
    return (
      <div data-testid="cost-inspector-error" className="text-xs text-rose-600 p-4">
        Failed to load LLM call cost data.
      </div>
    );
  }
  if (!steps || steps.length === 0) {
    return (
      <div data-testid="cost-inspector-empty" className="text-xs text-slate-500 p-4">
        No LLM calls recorded for this run yet.
      </div>
    );
  }

  return (
    <div data-testid="cost-inspector" className="flex flex-col gap-2 p-3">
      {steps.map((step) => (
        <StepCostRow key={step.startSeq} step={step} />
      ))}
    </div>
  );
}

/**
 * Look up the full `ProviderModel` for a step's provider+model pair.
 * Returns `undefined` while loading, when the provider isn't
 * credentialed, or when the model isn't registered. Both the context
 * ring and the per-token cost breakdown depend on this — pi-ai prices
 * in USD per million tokens, so we divide by 1e6 when applying the
 * rate.
 */
function useStepModel(provider: string | undefined, modelId: string | undefined): ProviderModel | undefined {
  const { data } = useQuery({
    queryKey: ["providers", provider] as const,
    queryFn: () => getProvider(provider!),
    enabled: !!provider,
    staleTime: 10 * 60 * 1000,
  });
  if (!data || !modelId) return undefined;
  return data.models.find((m) => m.id === modelId);
}

const COST_RATE_DIVISOR = 1_000_000;

function StepCostRow({ step }: { step: StepSnapshot }): JSX.Element {
  const model = useStepModel(step.provider, step.model);

  const inputTokens = step.cost?.input_tokens ?? 0;
  const outputTokens = step.cost?.output_tokens ?? 0;
  const cacheReadTokens = step.cost?.cache_read_tokens ?? 0;
  const totalTokens = step.cost !== undefined ? (step.cost.total_tokens ?? inputTokens + outputTokens) : 0;
  const usedTokens = totalTokens || inputTokens + cacheReadTokens;

  const inputCostUsd = model ? (model.cost.input * inputTokens) / COST_RATE_DIVISOR : undefined;
  const outputCostUsd = model ? (model.cost.output * outputTokens) / COST_RATE_DIVISOR : undefined;

  const showContextCircle = !!model?.contextWindow && model.contextWindow > 0 && usedTokens > 0;

  // All trailing chips (duration, cost, context ring) share the same
  // `text-xs text-muted-foreground tabular-nums` so the row reads as one
  // strip of metrics rather than three differently-sized elements.
  const metricChipClass = "text-xs text-muted-foreground tabular-nums";

  return (
    <div data-testid={`step-${step.stepIdx}`} className="border rounded-md bg-card px-3 py-2 flex items-center gap-3">
      <span className="text-sm font-semibold text-foreground flex-shrink-0">{step.nodeId}</span>
      {step.iteration && (
        <span className={`font-mono ${metricChipClass}`}>
          iter {step.iteration.n}/{step.iteration.max}
        </span>
      )}
      {step.model && (
        <span className={`font-mono ${metricChipClass}`}>
          {step.provider ?? "?"} / {step.model}
        </span>
      )}
      {step.fidelity && <span className={`font-mono ${metricChipClass}`}>{step.fidelity}</span>}
      <span className="ml-auto flex items-center gap-3">
        {step.durationMs !== undefined && <span className={metricChipClass}>⏱ {formatDuration(step.durationMs)}</span>}
        {step.cost !== undefined && (
          <span className={metricChipClass}>
            <AnimatedNumber value={step.cost.cost_usd} format={usdFormatOptions(step.cost.cost_usd)} />
          </span>
        )}
        {showContextCircle && (
          <Context
            maxTokens={model.contextWindow}
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
          >
            <ContextTrigger
              className={`h-auto gap-2 p-0 font-normal hover:bg-transparent hover:text-foreground ${metricChipClass} [&>span]:font-normal [&>span]:text-muted-foreground`}
            />
            <ContextContent>
              <ContextContentHeader />
              <ContextContentBody>
                <ContextInputUsage>
                  <UsageRow label="Input" tokens={inputTokens} costUsd={inputCostUsd} />
                </ContextInputUsage>
                <ContextOutputUsage>
                  <UsageRow label="Output" tokens={outputTokens} costUsd={outputCostUsd} />
                </ContextOutputUsage>
                <ContextCacheUsage>
                  <UsageRow label="Cache" tokens={cacheReadTokens} />
                </ContextCacheUsage>
              </ContextContentBody>
              <ContextContentFooter>
                <span className="text-muted-foreground">Total cost</span>
                <span className="tabular-nums">
                  {step.cost !== undefined ? (
                    <AnimatedNumber value={step.cost.cost_usd} format={usdFormatOptions(step.cost.cost_usd)} />
                  ) : (
                    "—"
                  )}
                </span>
              </ContextContentFooter>
            </ContextContent>
          </Context>
        )}
      </span>
    </div>
  );
}

function UsageRow({ label, tokens, costUsd }: { label: string; tokens: number; costUsd?: number }): JSX.Element {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">
        {formatTokensCompact(tokens)}
        {costUsd !== undefined && <span className="ml-2 text-muted-foreground">• {formatUsd(costUsd)}</span>}
      </span>
    </div>
  );
}
