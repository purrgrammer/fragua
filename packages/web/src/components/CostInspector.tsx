// Per-LLM-call cost + context inspector. Fetches `StepSnapshot[]` from
// `GET /runs/:id/steps` and renders one row per call: node id, elapsed,
// total $, and a click-to-open ring with the input / output / cache token
// + cost breakdown.
//
// The "Steps" tab used to dump the full step context (prompt, system
// prompt, prior messages, tools, context files, settings, budget,
// final assistant text). All of that already lives in the Conversation
// tab and is reachable via the messages table; duplicating it here just
// made the page noisy. The remaining purpose is auditing spend per call.
//
// Design:
//   - Server merges `eventsToSteps` + SQL cost aggregates and fills
//     `durationMs` for orphan steps (no `llm.done`) using the next
//     step's startedAt or the run's last-event ts on terminal runs.
//     The UI does no replay or numerical folding.
//   - Per-row cost breakdown is computed from the `ProviderModel` rate
//     card (USD per million tokens). `tokenlens` doesn't recognise
//     custom providers (e.g. `ppq:`) and would render every line as
//     `$0.00`.
//   - Cache reads are charged at a discounted rate; cache writes at a
//     premium. Both are shown as their own breakdown lines so the
//     popover communicates exactly where the run's spend went.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins, DollarSign, Timer } from "lucide-react";
import { useEffect } from "react";
import type { ProviderModel, StepSnapshot } from "../lib/api.ts";
import { formatTokensCompact, formatUsd, usdFormatOptions } from "../lib/format.ts";
import { queries } from "../lib/queries.ts";
import { formatDuration } from "../lib/time.ts";
import { useNow } from "../lib/useNow.ts";
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
  /** True while the run is still progressing. Drives the elapsed-time
   * ticker — when false, in-flight steps freeze on the server-supplied
   * `durationMs` instead of computing `now - startedAt` (which would
   * grow forever on a finished-but-orphan-step run). */
  isLive?: boolean;
}

export function CostInspector({ runId, totalEvents, isLive = false }: CostInspectorProps): JSX.Element {
  const qc = useQueryClient();
  const stepsQuery = queries.runs.steps(runId);
  const { data: steps, isPending, isError } = useQuery(stepsQuery);

  // biome-ignore lint/correctness/useExhaustiveDependencies: totalEvents is the intentional trigger; qc + stepsQuery.queryKey are stable.
  useEffect(() => {
    if (totalEvents !== undefined) void qc.invalidateQueries({ queryKey: stepsQuery.queryKey });
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

  // Outer grid defines the column tracks once; each row uses
  // `grid-cols-subgrid` to inherit them. Result: every row's cells
  // (nodeId, duration, cost, context) line up across the whole list,
  // while still rendering each row as its own bordered card.
  // grid-template-columns: [step | duration | cost | context]
  return (
    <div data-testid="cost-inspector" className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-y-2 p-3">
      {steps.map((step, i) => (
        <StepCostRow key={step.startSeq} step={step} nextStartedAt={steps[i + 1]?.startedAt} isLive={isLive} />
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
  const { data } = useQuery(queries.providers.detail(provider ?? ""));
  if (!data || !modelId) return undefined;
  return data.models.find((m) => m.id === modelId);
}

const COST_RATE_DIVISOR = 1_000_000;

function StepCostRow({
  step,
  nextStartedAt,
  isLive,
}: {
  step: StepSnapshot;
  nextStartedAt: string | undefined;
  isLive: boolean;
}): JSX.Element {
  const model = useStepModel(step.provider, step.model);

  // Resolve elapsed time, in priority order:
  //   1. `step.durationMs` from the server (preferred — set on `llm.done`
  //      or filled in by `fillOrphanDurations` for terminal runs).
  //   2. Client-side fallback: any orphan step that has a *next* step in
  //      the list ended when that next step started. This keeps the chip
  //      useful even against a backend that didn't fill the field
  //      (e.g. older daemon, mid-deploy).
  //   3. Live tick `now - startedAt` for the truly-active last step on a
  //      live run.
  //   4. Otherwise — hide the chip rather than show a stale value.
  const fallbackFromNext = (() => {
    if (step.durationMs !== undefined || nextStartedAt === undefined) return undefined;
    const endTs = Date.parse(nextStartedAt);
    const startTs = Date.parse(step.startedAt);
    if (!Number.isFinite(endTs) || !Number.isFinite(startTs) || endTs < startTs) return undefined;
    return endTs - startTs;
  })();
  const resolvedDurationMs = step.durationMs ?? fallbackFromNext;
  const stepIsTicking = resolvedDurationMs === undefined && isLive;
  const now = useNow(1_000, stepIsTicking);
  const liveElapsedMs =
    resolvedDurationMs ?? (stepIsTicking ? Math.max(0, now - Date.parse(step.startedAt)) : undefined);
  const elapsedIsLive = stepIsTicking;

  const inputTokens = step.cost?.input_tokens ?? 0;
  const outputTokens = step.cost?.output_tokens ?? 0;
  const cacheReadTokens = step.cost?.cache_read_tokens ?? 0;
  const cacheWriteTokens = step.cost?.cache_write_tokens ?? 0;
  // Tokens this step generated against the model's context window —
  // matches the run-header "Tokens" tile (input + output sum). The
  // provider-reported `total_tokens` field is not used: Anthropic
  // includes cache_read_tokens in it on cached calls and excludes it
  // on uncached ones, so summing across calls produced an inflated,
  // inconsistent number (the implement step on 01kq5962q5hee63nsk
  // showed 1.09M / 1M = 109% from that mixed accounting).
  const totalTokens = inputTokens + outputTokens;

  // Only Input / Output carry a $ figure in the breakdown — cache rows
  // intentionally don't, even though cache reads/writes are technically
  // billable. Their per-token rate often rounds to $0.00 against tiny
  // cache windows, which reads as "free" and is more confusing than
  // useful. The footer's `Total cost` already accounts for everything.
  const inputCostUsd = model ? (model.cost.input * inputTokens) / COST_RATE_DIVISOR : undefined;
  const outputCostUsd = model ? (model.cost.output * outputTokens) / COST_RATE_DIVISOR : undefined;

  const showContextCircle = !!model?.contextWindow && model.contextWindow > 0 && totalTokens > 0;

  // All trailing chips share the same `text-xs text-muted-foreground
  // tabular-nums` and a small leading icon so each metric is identifiable
  // at a glance — Timer for elapsed, DollarSign for cost, Coins for the
  // context-window utilisation. Without icons the bare numbers (`23s`,
  // `US$0.165`, `49.2%`) blurred together and the percentage especially
  // read as ambiguous (cost share? token share? context fill?).
  const metricChipClass = "text-xs text-muted-foreground tabular-nums inline-flex items-center gap-1";

  // The row inherits its column tracks from `CostInspector`'s outer
  // grid via `grid-cols-subgrid`. Spanning all 4 columns keeps the row
  // visually a single card while letting its 4 cells fall into the
  // parent's tracks — so cells line up across every row in the list.
  // `justify-self-end` on each metric cell right-aligns its chip;
  // empty cells (e.g. a step missing cost data) still hold column
  // space so neighbouring rows' chips don't shift.
  const rowGridClass = "grid grid-cols-subgrid col-span-4 items-center gap-x-4 border rounded-md bg-card px-3 py-2";

  return (
    <div data-testid={`step-${step.stepIdx}`} className={rowGridClass}>
      <span className="text-sm font-semibold text-foreground truncate flex items-center gap-2">
        <span className="truncate">{step.nodeId}</span>
        {step.iteration && (
          <span className={`font-mono ${metricChipClass}`}>
            iter {step.iteration.n}/{step.iteration.max}
          </span>
        )}
      </span>
      <span className={`${metricChipClass} justify-self-end`}>
        {liveElapsedMs !== undefined && (
          <span
            className={metricChipClass}
            data-testid={`step-${step.stepIdx}-elapsed`}
            data-live={elapsedIsLive ? "true" : undefined}
            title={elapsedIsLive ? "step in progress" : "elapsed time"}
          >
            <Timer className="size-3" aria-hidden />
            {formatDuration(liveElapsedMs)}
          </span>
        )}
      </span>
      <span className={`${metricChipClass} justify-self-end`}>
        {step.cost !== undefined && (
          <span className={metricChipClass} title="cost">
            <DollarSign className="size-3" aria-hidden />
            <AnimatedNumber value={step.cost.cost_usd} format={usdFormatOptions(step.cost.cost_usd)} />
          </span>
        )}
      </span>
      <span className={`${metricChipClass} justify-self-end`}>
        {showContextCircle && (
          <Context
            maxTokens={model.contextWindow}
            usedTokens={totalTokens}
            usage={{
              inputTokens,
              outputTokens,
              cachedInputTokens: cacheReadTokens,
              reasoningTokens: 0,
              totalTokens,
              inputTokenDetails: {
                noCacheTokens: inputTokens,
                cacheReadTokens,
                cacheWriteTokens,
              },
              outputTokenDetails: {
                textTokens: outputTokens,
                reasoningTokens: 0,
              },
            }}
          >
            <span className="inline-flex items-center gap-1" title="context window utilisation">
              <Coins className="size-3 text-muted-foreground" aria-hidden />
              <ContextTrigger
                className={`h-auto gap-2 p-0 font-normal hover:bg-transparent hover:text-foreground ${metricChipClass} [&>span]:font-normal [&>span]:text-muted-foreground`}
              />
            </span>
            <ContextContent>
              <ContextContentHeader />
              <ContextContentBody>
                {/* CSS-grid table so token + cost columns line up
                 * across all rows regardless of label width. The rows
                 * are flat (not nested) — semantic grouping (cache read
                 * under Input, cache write under Output) is preserved
                 * via row order and the indented label class, which is
                 * easier to read than visually nested elements. */}
                <div className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-4 gap-y-1 text-xs">
                  <ContextInputUsage>
                    <UsageGridRow label="Input" tokens={inputTokens} costUsd={inputCostUsd} />
                  </ContextInputUsage>
                  {cacheReadTokens > 0 && (
                    <ContextCacheUsage>
                      <UsageGridRow label="Cache read" tokens={cacheReadTokens} subtle />
                    </ContextCacheUsage>
                  )}
                  <ContextOutputUsage>
                    <UsageGridRow label="Output" tokens={outputTokens} costUsd={outputCostUsd} />
                  </ContextOutputUsage>
                  {cacheWriteTokens > 0 && <UsageGridRow label="Cache write" tokens={cacheWriteTokens} subtle />}
                </div>
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

/**
 * One `(label, tokens, cost)` row in the cost breakdown popover.
 * Renders three sibling cells into the parent's CSS grid so labels,
 * token counts, and dollar figures line up across rows regardless of
 * width. `subtle` mutes cache-read / cache-write rows so the primary
 * Input / Output rows visually dominate and cache reads as derived
 * detail rather than parallel buckets.
 */
function UsageGridRow({
  label,
  tokens,
  costUsd,
  subtle,
}: {
  label: string;
  tokens: number;
  costUsd?: number;
  subtle?: boolean;
}): JSX.Element {
  const labelClass = subtle ? "text-muted-foreground/80 pl-3" : "text-muted-foreground";
  const numericClass = subtle ? "tabular-nums text-right text-muted-foreground" : "tabular-nums text-right";
  const costClass = "tabular-nums text-right text-muted-foreground";
  return (
    <>
      <span className={labelClass}>{label}</span>
      <span className={numericClass}>{formatTokensCompact(tokens)}</span>
      <span className={costClass}>{costUsd !== undefined ? formatUsd(costUsd) : ""}</span>
    </>
  );
}
