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
import { cn } from "../lib/cn.ts";
import {
  formatTokensCompact,
  formatUsd,
  pickSharedTokensOptions,
  pickSharedUsdOptions,
  usdFormatOptions,
} from "../lib/format.ts";
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
  const {
    data: steps,
    isPending,
    isError,
  } = useQuery({
    ...stepsQuery,
    refetchInterval: isLive ? 1_000 : false,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: totalEvents is the intentional trigger; qc + stepsQuery.queryKey are stable.
  useEffect(() => {
    if (totalEvents !== undefined) void qc.invalidateQueries({ queryKey: stepsQuery.queryKey });
  }, [totalEvents]);

  if (isPending) {
    return (
      <div data-testid="cost-inspector-loading" className="text-xs text-sw-muted p-4">
        Loading…
      </div>
    );
  }
  if (isError) {
    return (
      <div data-testid="cost-inspector-error" className="text-xs text-sw-accent-error p-4">
        Failed to load LLM call cost data.
      </div>
    );
  }
  if (!steps || steps.length === 0) {
    return (
      <div data-testid="cost-inspector-empty" className="text-xs text-sw-muted p-4">
        No LLM calls recorded for this run yet.
      </div>
    );
  }

  // Partition into top-level vs branch rows. Branch rows are indented
  // under their parent and the parent renders as a non-leaf summary
  // (cost / tokens aggregated across itself + every child).
  //
  // Grouping key: `(parentNodeId, parentStartSeq)`. Sub-agent rows
  // carry `parentStartSeq` = the parent step's `startSeq` at spawn
  // time, so a goal-gate retarget that re-invokes the same parent
  // node_id keeps each invocation's children scoped to its own row.
  // Parallel branches don't carry `parentStartSeq` (a parallel parent
  // runs once per node window, so there's no per-invocation collision
  // to disambiguate); they fall back to a `parentNodeId|*` slot that
  // every same-node parent row reads from.
  //
  // Synthetic parents for parallel sections: a `parallel` handler opens
  // no LLM call of its own, so no top-level step carries the parent's
  // nodeId — but its children come back tagged with `parentNodeId` set
  // to the parallel node. Without a stand-in, the panel either renders
  // blank (children file into childrenByParent and never match a
  // top-level row) or — if we hoist children flat — loses the nesting
  // operators rely on to read the fan-out structure. Synthesise a
  // parent row keyed on the parent's nodeId so the indented children
  // attach correctly and the aggregate cost/tokens summary fires.
  const PARENT_NODE_WILDCARD = "*";
  const groupKey = (parentNodeId: string, parentStartSeq: number | undefined): string =>
    `${parentNodeId}|${parentStartSeq ?? PARENT_NODE_WILDCARD}`;
  const topLevelParentNodeIds = new Set<string>();
  for (const s of steps) {
    const isBranch = typeof s.parentNodeId === "string" && s.parentNodeId.length > 0;
    if (!isBranch) topLevelParentNodeIds.add(s.nodeId);
  }
  const childrenByParent = new Map<string, StepSnapshot[]>();
  const topLevel: StepSnapshot[] = [];
  const synthesisedParents = new Map<string, StepSnapshot>();
  let synthCount = 0;
  for (const s of steps) {
    const isBranch = typeof s.parentNodeId === "string" && s.parentNodeId.length > 0;
    if (isBranch) {
      const parentNodeId = s.parentNodeId as string;
      const key = groupKey(parentNodeId, s.parentStartSeq);
      const arr = childrenByParent.get(key) ?? [];
      arr.push(s);
      childrenByParent.set(key, arr);
      if (!topLevelParentNodeIds.has(parentNodeId) && !synthesisedParents.has(parentNodeId)) {
        synthCount += 1;
        const synthParent: StepSnapshot = {
          // Negative ids — guaranteed not to collide with real (>=0)
          // step indices or stream sequences. Stable across renders
          // because `synthCount` increments deterministically as we
          // walk `steps`.
          stepIdx: -synthCount,
          startSeq: -synthCount,
          nodeId: parentNodeId,
          startedAt: s.startedAt,
        };
        synthesisedParents.set(parentNodeId, synthParent);
        topLevel.push(synthParent);
      }
    } else {
      topLevel.push(s);
    }
  }

  // Outer grid defines the column tracks once; each row uses
  // `grid-cols-subgrid` to inherit them. Result: every row's cells
  // (nodeId, duration, cost, context) line up across the whole list,
  // while still rendering each row as its own bordered card.
  // grid-template-columns: [step | duration | cost | context]
  return (
    <div data-testid="cost-inspector" className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-y-2 p-3">
      {topLevel.map((step, i) => {
        // A parent matches its own invocation's children first via
        // `(nodeId, startSeq)`; parallel parents fall back to the
        // wildcard slot populated by branches without `parentStartSeq`.
        const branchChildren =
          childrenByParent.get(groupKey(step.nodeId, step.startSeq)) ??
          childrenByParent.get(groupKey(step.nodeId, undefined));
        const next = topLevel[i + 1] ?? branchChildren?.[0];
        return (
          <StepCostRowGroup
            key={stepIdentityKey(step, runId)}
            step={step}
            branchChildren={branchChildren}
            nextStartedAt={next?.startedAt}
            isLive={isLive}
          />
        );
      })}
    </div>
  );
}

function stepIdentityKey(step: StepSnapshot, fallbackRunId: string): string {
  return `${step.originRunId ?? fallbackRunId}:${step.startSeq}`;
}

/** A top-level step plus any indented branch rows that ride underneath it. */
function StepCostRowGroup({
  step,
  branchChildren,
  nextStartedAt,
  isLive,
}: {
  step: StepSnapshot;
  branchChildren: StepSnapshot[] | undefined;
  nextStartedAt: string | undefined;
  isLive: boolean;
}): JSX.Element {
  const hasBranchChildren = branchChildren !== undefined && branchChildren.length > 0;
  // Summary mode: the parent's displayed cost / tokens aggregate itself
  // plus every child branch. The inspector's per-row breakdown still
  // shows each branch's own cost, so total + per-branch read consistently.
  const summary = hasBranchChildren ? aggregateSteps(step, branchChildren) : undefined;
  return (
    <>
      <StepCostRow
        step={step}
        nextStartedAt={nextStartedAt}
        isLive={isLive}
        summary={summary}
        hasChildren={hasBranchChildren}
      />
      {hasBranchChildren
        ? branchChildren.map((child, j) => (
            <StepCostRow
              key={stepIdentityKey(child, step.originRunId ?? "")}
              step={child}
              nextStartedAt={branchChildren[j + 1]?.startedAt ?? nextStartedAt}
              isLive={isLive}
              isBranchChild
            />
          ))
        : null}
    </>
  );
}

/** Aggregate a parent step + its branch / sub-agent children into a
 *  single summary row. `cost` defaults to zeros so the popover still
 *  renders even when the parent had no LLM call of its own (the
 *  parallel handler doesn't open one for the component shell).
 *
 *  Cost and tokens are summed: each child spent its own money on top
 *  of whatever the parent spent. Duration is NOT summed — children
 *  run inside the parent's wall window (parallel branches run inline
 *  under the component's dispatch; sub-agents block the parent's LLM
 *  turn). `parent.durationMs` already covers them. Summing would
 *  produce a figure several times the actual wall clock — for a
 *  4-branch fan-out, ~5× the truth. */
function aggregateSteps(
  parent: StepSnapshot,
  children: readonly StepSnapshot[],
): NonNullable<StepSnapshot["cost"]> & { durationMs: number | undefined } {
  let inputTokens = parent.cost?.input_tokens ?? 0;
  let outputTokens = parent.cost?.output_tokens ?? 0;
  let cacheReadTokens = parent.cost?.cache_read_tokens ?? 0;
  let cacheWriteTokens = parent.cost?.cache_write_tokens ?? 0;
  let billedTokens = parent.cost?.billed_tokens ?? 0;
  let costUsd = parent.cost?.cost_usd ?? 0;
  for (const c of children) {
    inputTokens += c.cost?.input_tokens ?? 0;
    outputTokens += c.cost?.output_tokens ?? 0;
    cacheReadTokens += c.cost?.cache_read_tokens ?? 0;
    cacheWriteTokens += c.cost?.cache_write_tokens ?? 0;
    billedTokens += c.cost?.billed_tokens ?? 0;
    costUsd += c.cost?.cost_usd ?? 0;
  }
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    billed_tokens: billedTokens,
    cost_usd: costUsd,
    durationMs: parent.durationMs,
  };
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
  summary,
  hasChildren = false,
  isBranchChild = false,
}: {
  step: StepSnapshot;
  nextStartedAt: string | undefined;
  isLive: boolean;
  /** When set, the row's displayed cost / tokens / duration override
   *  the step's own values — used for the parent summary that
   *  aggregates parent + branch children. */
  summary?: NonNullable<StepSnapshot["cost"]> & { durationMs: number | undefined };
  /** Parent has indented branch rows underneath. Marks the row with
   *  `data-summary="true"` for testability and applies a slightly
   *  emphasised background. */
  hasChildren?: boolean;
  /** This row is a branch child — indent and tone down the chrome. */
  isBranchChild?: boolean;
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

  // Summary rows pull from the aggregated `summary` so the parent's
  // displayed total includes every child branch's contribution.
  const inputTokens = summary?.input_tokens ?? step.cost?.input_tokens ?? 0;
  const outputTokens = summary?.output_tokens ?? step.cost?.output_tokens ?? 0;
  const cacheReadTokens = summary?.cache_read_tokens ?? step.cost?.cache_read_tokens ?? 0;
  const cacheWriteTokens = summary?.cache_write_tokens ?? step.cost?.cache_write_tokens ?? 0;
  const displayedCostUsd = summary?.cost_usd ?? step.cost?.cost_usd;
  const displayedDurationMs = summary?.durationMs ?? liveElapsedMs;
  // Fresh tokens — new content this step contributed: input + cache_write
  // (Anthropic puts the system prompt in cache_write on the first turn) +
  // output. Cache_read is reused content from a prior turn's cache_write,
  // already counted there, so excluded from the per-step gauge to keep it
  // a "new work this step" signal. Run-level tiles use billed (= fresh +
  // cache_read) for the headline + invoice match.
  const freshTokens = inputTokens + cacheWriteTokens + outputTokens;

  // Per-bucket $ figures so Input + Cache write + Cache read + Output rows
  // sum to the displayed Total cost. Each bucket has its own rate:
  // cache_write ~1.25× input, cache_read ~0.1× input.
  const inputCostUsd = model ? (model.cost.input * inputTokens) / COST_RATE_DIVISOR : undefined;
  const cacheWriteCostUsd = model ? (model.cost.cacheWrite * cacheWriteTokens) / COST_RATE_DIVISOR : undefined;
  const cacheReadCostUsd = model ? (model.cost.cacheRead * cacheReadTokens) / COST_RATE_DIVISOR : undefined;
  const outputCostUsd = model ? (model.cost.output * outputTokens) / COST_RATE_DIVISOR : undefined;

  const showContextCircle = !!model?.contextWindow && model.contextWindow > 0 && freshTokens > 0;

  // Derive ONE format spec for $ and tokens from the smallest non-zero
  // value across the four breakdown rows so decimals line up. Otherwise
  // input ($0.12) and cache_read ($0.0003) pick different fraction-digit
  // counts and read as ragged in the stack. Cache read often forces 4
  // digits → all four rows render at 4 digits within this step.
  const sharedUsdOptions = pickSharedUsdOptions([inputCostUsd, cacheWriteCostUsd, cacheReadCostUsd, outputCostUsd]);
  const sharedTokensOptions = pickSharedTokensOptions([inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens]);

  // All trailing chips share the same `text-xs text-sw-muted
  // tabular-nums` and a small leading icon so each metric is identifiable
  // at a glance — Timer for elapsed, DollarSign for cost, Coins for the
  // context-window utilisation. Without icons the bare numbers (`23s`,
  // `US$0.165`, `49.2%`) blurred together and the percentage especially
  // read as ambiguous (cost share? token share? context fill?).
  const metricChipClass = "text-xs text-sw-muted tabular-nums inline-flex items-center gap-1";

  // The row inherits its column tracks from `CostInspector`'s outer
  // grid via `grid-cols-subgrid`. Spanning all 4 columns keeps the row
  // visually a single card while letting its 4 cells fall into the
  // parent's tracks — so cells line up across every row in the list.
  // `justify-self-end` on each metric cell right-aligns its chip;
  // empty cells (e.g. a step missing cost data) still hold column
  // space so neighbouring rows' chips don't shift.
  const rowGridClass = cn(
    "grid grid-cols-subgrid col-span-4 items-center gap-x-4 border rounded-md",
    isBranchChild ? "bg-sw-surface/50 px-3 py-1 ml-6" : "bg-sw-surface px-3 py-2",
  );

  return (
    <div
      data-testid={`step-${step.stepIdx}`}
      data-summary={hasChildren ? "true" : undefined}
      data-parent-step={step.parentNodeId}
      data-branch-child={isBranchChild ? "true" : undefined}
      className={rowGridClass}
    >
      <span className="text-sm font-semibold text-sw-text truncate flex items-center gap-2">
        <span className="truncate" title={step.subagentId ? `subagent_id: ${step.subagentId}` : undefined}>
          {step.subagentId ? `agent · ${step.subagentName ?? step.subagentId.slice(0, 8)}` : step.nodeId}
        </span>
        {step.iteration && (
          <span className={`font-mono ${metricChipClass}`}>
            iter {step.iteration.n}/{step.iteration.max}
          </span>
        )}
      </span>
      <span className={`${metricChipClass} justify-self-end`}>
        {displayedDurationMs !== undefined && (
          <span
            className={metricChipClass}
            data-testid={`step-${step.stepIdx}-elapsed`}
            data-live={elapsedIsLive ? "true" : undefined}
            title={elapsedIsLive ? "step in progress" : "elapsed time"}
          >
            <Timer className="size-3" aria-hidden />
            {formatDuration(displayedDurationMs)}
          </span>
        )}
      </span>
      <span className={`${metricChipClass} justify-self-end`}>
        {displayedCostUsd !== undefined && (
          <span className={metricChipClass} title={hasChildren ? "total cost (parent + branches)" : "cost"}>
            <DollarSign className="size-3" aria-hidden />
            <AnimatedNumber value={displayedCostUsd} format={usdFormatOptions(displayedCostUsd)} />
          </span>
        )}
      </span>
      <span className={`${metricChipClass} justify-self-end`}>
        {showContextCircle && (
          <Context
            maxTokens={model.contextWindow}
            usedTokens={freshTokens}
            usage={{
              inputTokens,
              outputTokens,
              cachedInputTokens: cacheReadTokens,
              reasoningTokens: 0,
              totalTokens: freshTokens,
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
              <Coins className="size-3 text-sw-muted" aria-hidden />
              <ContextTrigger
                className={`h-auto gap-2 p-0 font-normal hover:bg-transparent hover:text-sw-text ${metricChipClass} [&>span]:font-normal [&>span]:text-sw-muted`}
              />
            </span>
            <ContextContent>
              <ContextContentHeader />
              <ContextContentBody>
                {/* CSS-grid table so token + cost columns line up
                 * across all rows regardless of label width. Four
                 * parallel rows (Input / Cache write / Cache read /
                 * Output) sum to Total cost. */}
                <div className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-4 gap-y-1 text-xs">
                  <ContextInputUsage>
                    <UsageGridRow
                      label="Input"
                      tokens={inputTokens}
                      costUsd={inputCostUsd}
                      usdOptions={sharedUsdOptions}
                      tokensOptions={sharedTokensOptions}
                    />
                  </ContextInputUsage>
                  {cacheWriteTokens > 0 && (
                    <ContextCacheUsage>
                      <UsageGridRow
                        label="Cache write"
                        tokens={cacheWriteTokens}
                        costUsd={cacheWriteCostUsd}
                        usdOptions={sharedUsdOptions}
                        tokensOptions={sharedTokensOptions}
                        subtle
                      />
                    </ContextCacheUsage>
                  )}
                  {cacheReadTokens > 0 && (
                    <ContextCacheUsage>
                      <UsageGridRow
                        label="Cache read"
                        tokens={cacheReadTokens}
                        costUsd={cacheReadCostUsd}
                        usdOptions={sharedUsdOptions}
                        tokensOptions={sharedTokensOptions}
                        subtle
                      />
                    </ContextCacheUsage>
                  )}
                  <ContextOutputUsage>
                    <UsageGridRow
                      label="Output"
                      tokens={outputTokens}
                      costUsd={outputCostUsd}
                      usdOptions={sharedUsdOptions}
                      tokensOptions={sharedTokensOptions}
                    />
                  </ContextOutputUsage>
                </div>
              </ContextContentBody>
              <ContextContentFooter>
                <span className="text-sw-muted">{hasChildren ? "Total (parent + branches)" : "Total cost"}</span>
                <span className="tabular-nums">
                  {displayedCostUsd !== undefined ? (
                    <AnimatedNumber value={displayedCostUsd} format={usdFormatOptions(displayedCostUsd)} />
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
  usdOptions,
  tokensOptions,
}: {
  label: string;
  tokens: number;
  costUsd?: number;
  subtle?: boolean;
  /** Shared $-format options derived from the smallest cost across all
   * sibling rows; ensures decimal alignment within a step. */
  usdOptions?: Intl.NumberFormatOptions;
  /** Shared tokens-format options derived from the smallest token count
   * across all sibling rows. */
  tokensOptions?: Intl.NumberFormatOptions;
}): JSX.Element {
  const labelClass = subtle ? "text-sw-muted/80 pl-3" : "text-sw-muted";
  const numericClass = subtle ? "tabular-nums text-right text-sw-muted" : "tabular-nums text-right";
  const costClass = "tabular-nums text-right text-sw-muted";
  return (
    <>
      <span className={labelClass}>{label}</span>
      <span className={numericClass}>
        {tokensOptions ? formatTokensCompact(tokens, { intlOptions: tokensOptions }) : formatTokensCompact(tokens)}
      </span>
      <span className={costClass}>
        {costUsd !== undefined
          ? usdOptions
            ? formatUsd(costUsd, { intlOptions: usdOptions })
            : formatUsd(costUsd)
          : ""}
      </span>
    </>
  );
}
