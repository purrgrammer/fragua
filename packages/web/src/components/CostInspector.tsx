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
import { Fragment, useEffect, useMemo } from "react";
import type { ProviderModel, RunDetail, StepSnapshot } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { fanoutTopology } from "../lib/fanout-topology.ts";
import {
  formatTokensCompact,
  formatUsd,
  pickSharedTokensOptions,
  pickSharedUsdOptions,
  usdFormatOptions,
} from "../lib/format.ts";
import { nodeTypeIcon } from "../lib/node-icons.ts";
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
import { ModelBadge } from "./ui/model-badge.tsx";

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
  /** Server-derived fan-out topology records (`RunDetail.fanout`). Maps each
   * step's nodeId → handler type so every row leads with the right type
   * glyph (llm / tool / human / parallel / …) and carries the branch lineage
   * that groups a lens's steps. When absent, rows fall back to the neutral
   * icon and flat ordering. */
  fanout?: RunDetail["fanout"];
}

export function CostInspector({
  runId,
  totalEvents,
  isLive = false,
  fanout: fanoutRecords,
}: CostInspectorProps): JSX.Element {
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

  // Lift the served records into Maps ONCE for both the node-type glyphs (so
  // a tool row reads as a tool, not an llm) and the fan-out branch lineage
  // (sub-node → its `scan → verify` branch + each branch's order) that orders
  // a lens's steps together and rules a separator between branches.
  const topology = useMemo(() => fanoutTopology(fanoutRecords), [fanoutRecords]);
  const nodeTypes = topology.nodeTypes;
  const branchInfo = useMemo(() => ({ branchOf: topology.branchOf, order: topology.orderOf }), [topology]);

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

  // Merge multi-turn / pause+resume duplicates: each `llm.start`
  // becomes its own StepSnapshot, so a llm handler that takes
  // multiple turns produces N rows for one nodeId; raise+resume
  // produces another N. Collapse them into ONE row per nodeId —
  // summed cost/tokens, earliest startedAt, latest durationMs end,
  // with `turns` carrying the count. The underlying per-call detail
  // is still available via /steps for any future drill-in surface.
  const mergedSteps = mergeStepsByNode(steps);
  // Collapse each run of `type: parallel` branch steps (tagged with the
  // same parentNodeId by the steps projection) into one group so the
  // breakdown reads parent → branches (indented) instead of scattering
  // concurrent branches as flat sibling rows.
  const displayItems = groupParallelSteps(mergedSteps);
  // Duration fallback for an orphan step is the NEXT step's start in
  // timeline order — keyed off the flat merged list so grouping doesn't
  // perturb it.
  const nextStartedAtBySeq = new Map<number, string | undefined>();
  for (let i = 0; i < mergedSteps.length; i++) {
    nextStartedAtBySeq.set(mergedSteps[i]!.startSeq, mergedSteps[i + 1]?.startedAt);
  }

  // Outer grid defines the column tracks once; each row uses
  // `grid-cols-subgrid` to inherit them. Result: every row's cells
  // (nodeId, duration, cost, context) line up across the whole list,
  // while still rendering each row as its own bordered card.
  // grid-template-columns: [step | duration | cost | context]
  return (
    <div data-testid="cost-inspector" className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-y-2 p-3">
      {displayItems.map((item) =>
        item.kind === "parallel" ? (
          <ParallelCostGroup
            key={`parallel-${item.parentNodeId}-${item.branches[0]?.startSeq}`}
            parentNodeId={item.parentNodeId}
            branches={item.branches}
            nodeTypes={nodeTypes}
            branchInfo={branchInfo}
            isLive={isLive}
          />
        ) : (
          <StepCostRow
            key={stepIdentityKey(item.step)}
            step={item.step}
            nodeType={nodeTypes.get(item.step.nodeId)}
            nextStartedAt={nextStartedAtBySeq.get(item.step.startSeq)}
            isLive={isLive}
          />
        ),
      )}
    </div>
  );
}

type CostDisplayItem =
  | { kind: "step"; step: StepSnapshot }
  | { kind: "parallel"; parentNodeId: string; branches: StepSnapshot[] };

/** Collapse consecutive steps sharing a `parentNodeId` into one parallel
 * group, then fold each branch's rows into ONE row per distinct branch.
 * `mergeStepsByNode` only merges *consecutive* same-node rows, but a fan-out's
 * branches interleave — and a budget re-drive re-runs every branch — so a
 * branch's rows are scattered. Merging by nodeId here keeps the breakdown
 * honest — one row per distinct branch (not per row), summing a branch's spend
 * across re-drive rounds. Non-branch steps pass through. */
function groupParallelSteps(steps: readonly StepSnapshot[]): CostDisplayItem[] {
  const out: CostDisplayItem[] = [];
  let i = 0;
  while (i < steps.length) {
    const parent = steps[i]!.parentNodeId;
    if (parent === undefined) {
      out.push({ kind: "step", step: steps[i]! });
      i += 1;
      continue;
    }
    const rows: StepSnapshot[] = [];
    while (i < steps.length && steps[i]!.parentNodeId === parent) {
      rows.push(steps[i]!);
      i += 1;
    }
    out.push({ kind: "parallel", parentNodeId: parent, branches: mergeBranchesByNode(rows) });
  }
  return out;
}

/** One row per distinct branch nodeId (first-seen order), summing a branch's
 * rows across re-drive rounds via `collapseTurns`. */
function mergeBranchesByNode(rows: readonly StepSnapshot[]): StepSnapshot[] {
  const byNode = new Map<string, StepSnapshot[]>();
  const order: string[] = [];
  for (const r of rows) {
    const group = byNode.get(r.nodeId);
    if (group) group.push(r);
    else {
      byNode.set(r.nodeId, [r]);
      order.push(r.nodeId);
    }
  }
  return order.map((id) => {
    const group = byNode.get(id)!;
    return group.length === 1 ? group[0]! : collapseTurns(group);
  });
}

/** A `type: parallel` fan-out group in the Cost breakdown: a parent header
 * carrying the aggregate spend + wall-clock span (branches run
 * concurrently, so the group's duration is the SPAN, not the sum of branch
 * durations), over the per-branch rows indented beneath it. */
function ParallelCostGroup({
  parentNodeId,
  branches,
  nodeTypes,
  branchInfo,
  isLive,
}: {
  parentNodeId: string;
  branches: StepSnapshot[];
  nodeTypes: ReadonlyMap<string, string>;
  branchInfo: { branchOf: ReadonlyMap<string, string>; order: ReadonlyMap<string, number> };
  isLive: boolean;
}): JSX.Element {
  // A branch with no `durationMs` is still in flight; while the run is live its
  // end is "now", so the group's wall-clock span keeps ticking until the last
  // branch joins (rather than freezing at the slowest *completed* branch).
  const anyRunning = branches.some((b) => b.durationMs == null);
  const groupTicking = isLive && anyRunning;
  // Order the merged branch rows so each lens's steps (scan → verify) sit
  // together. Stable sort by branch index keeps scan before verify within a lens.
  const orderedBranches = branches
    .map((b, i) => ({ b, i }))
    .sort((x, y) => {
      const bx = branchInfo.order.get(branchInfo.branchOf.get(x.b.nodeId) ?? x.b.nodeId) ?? 0;
      const by = branchInfo.order.get(branchInfo.branchOf.get(y.b.nodeId) ?? y.b.nodeId) ?? 0;
      return bx - by || x.i - y.i;
    })
    .map((e) => e.b);
  const now = useNow(1_000, groupTicking);
  const ParallelIcon = nodeTypeIcon(nodeTypes.get(parentNodeId) ?? "parallel");
  let costUsd = 0;
  let anyCost = false;
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = Number.NEGATIVE_INFINITY;
  for (const b of branches) {
    if (b.cost) {
      costUsd += b.cost.cost_usd;
      anyCost = true;
    }
    const start = Date.parse(b.startedAt);
    if (!Number.isFinite(start)) continue;
    minStart = Math.min(minStart, start);
    const end = b.durationMs != null ? start + b.durationMs : groupTicking ? now : start;
    maxEnd = Math.max(maxEnd, end);
  }
  const spanMs = Number.isFinite(minStart) && maxEnd > minStart ? maxEnd - minStart : undefined;
  const chip = "text-xs text-sw-muted tabular-nums inline-flex items-center gap-1";
  return (
    <>
      <div
        data-testid={`parallel-cost-${parentNodeId}`}
        className="grid grid-cols-subgrid col-span-4 items-center gap-x-4 rounded-md border bg-sw-surface px-3 py-2"
      >
        <span className="flex items-center gap-2 truncate text-sm font-semibold text-sw-text">
          <ParallelIcon className="size-3.5 shrink-0 text-sw-muted" aria-hidden />
          <span className="truncate">{parentNodeId}</span>
        </span>
        <span className={`${chip} justify-self-end`}>
          {spanMs !== undefined && (
            <span
              className={chip}
              data-live={groupTicking ? "true" : undefined}
              title={groupTicking ? "fan-out in progress" : "wall-clock span"}
            >
              <Timer className="size-3" aria-hidden />
              {formatDuration(spanMs)}
            </span>
          )}
        </span>
        <span className={`${chip} justify-self-end`}>
          {anyCost && (
            <span className={chip} title="cost">
              <DollarSign className="size-3" aria-hidden />
              <AnimatedNumber value={costUsd} format={usdFormatOptions(costUsd)} />
            </span>
          )}
        </span>
        <span />
      </div>
      {orderedBranches.map((b, i) => {
        const branch = branchInfo.branchOf.get(b.nodeId) ?? b.nodeId;
        const prevBranch =
          i > 0 ? (branchInfo.branchOf.get(orderedBranches[i - 1]!.nodeId) ?? orderedBranches[i - 1]!.nodeId) : branch;
        return (
          <Fragment key={stepIdentityKey(b)}>
            {/* Hairline between branches so a lens's scan + verify read as one unit. */}
            {i > 0 && branch !== prevBranch && (
              <div className="col-span-4 mx-3 border-t border-sw-border/60" aria-hidden />
            )}
            <StepCostRow
              step={b}
              nodeType={nodeTypes.get(b.nodeId)}
              // A branch has no sequential "next" — its successor is the join sink
              // after the barrier, not the sibling that happens to start next. So a
              // still-running branch ticks live instead of freezing at the gap to a
              // sibling's start.
              nextStartedAt={undefined}
              isLive={isLive}
              indent
            />
          </Fragment>
        );
      })}
    </>
  );
}

/** Merge CONSECUTIVE steps that share the same logical "node window":
 *  same nodeId. Each `llm.start` in the server's stream produces one
 *  StepSnapshot; llm multi-turn and pause-resume both yield several
 *  within the same node window. Operators care about the node's TOTAL
 *  spend, not the per-turn rows, so we sum here. `turns` carries the
 *  merge count for the UI to surface as "lens · 7 turns".
 *
 *  Why consecutive-only: a goal-gate retarget runs the SAME node a
 *  second time after other steps push between. Those legitimately
 *  distinct invocations are non-consecutive in the timeline; merging
 *  them would collapse a retry loop's spend into one misleading row.
 *  Pause/resume + multi-turn produce contiguous llm.starts in the
 *  same node window, so the consecutive bound captures them while
 *  keeping goal-gate retargets distinct. */
export function mergeStepsByNode(steps: readonly StepSnapshot[]): StepSnapshot[] {
  const groupKey = (s: StepSnapshot): string => s.nodeId;
  const out: StepSnapshot[] = [];
  let runStart = 0;
  while (runStart < steps.length) {
    const head = steps[runStart]!;
    const headKey = groupKey(head);
    let runEnd = runStart + 1;
    while (runEnd < steps.length && groupKey(steps[runEnd]!) === headKey) runEnd += 1;
    if (runEnd - runStart === 1) {
      out.push(head);
    } else {
      out.push(collapseTurns(steps.slice(runStart, runEnd)));
    }
    runStart = runEnd;
  }
  return out;
}

function collapseTurns(rows: readonly StepSnapshot[]): StepSnapshot {
  const first = rows[0]!;
  // Pick the earliest startedAt + earliest startSeq as the row's
  // identity; sum cost/tokens; use the latest available durationMs
  // (some turns will have it set, the in-flight tail may not).
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let billedTokens = 0;
  let latestEnd: number | undefined;
  for (const r of rows) {
    costUsd += r.cost?.cost_usd ?? 0;
    inputTokens += r.cost?.input_tokens ?? 0;
    outputTokens += r.cost?.output_tokens ?? 0;
    cacheReadTokens += r.cost?.cache_read_tokens ?? 0;
    cacheWriteTokens += r.cost?.cache_write_tokens ?? 0;
    billedTokens += r.cost?.billed_tokens ?? 0;
    if (r.durationMs != null) {
      const startMs = Date.parse(r.startedAt);
      const end = startMs + r.durationMs;
      if (latestEnd == null || end > latestEnd) latestEnd = end;
    }
  }
  const startMs = Date.parse(first.startedAt);
  const merged: StepSnapshot = { ...first };
  if (latestEnd != null && Number.isFinite(latestEnd) && latestEnd > startMs) {
    merged.durationMs = latestEnd - startMs;
  }
  merged.cost = {
    cost_usd: costUsd,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    billed_tokens: billedTokens,
  };
  merged.turns = rows.length;
  return merged;
}

function stepIdentityKey(step: StepSnapshot): string {
  return String(step.startSeq);
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
  nodeType,
  nextStartedAt,
  isLive,
  indent = false,
}: {
  step: StepSnapshot;
  /** Handler type of this step's node (from the workflow graph). Drives the
   * leading type glyph; `undefined` falls back to the neutral icon. */
  nodeType?: string;
  nextStartedAt: string | undefined;
  isLive: boolean;
  /** Render as a fan-out branch under a `ParallelCostGroup` — gently inset so
   * the nesting reads, otherwise identical to a linear step row. */
  indent?: boolean;
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
  const displayedCostUsd = step.cost?.cost_usd;
  const displayedDurationMs = liveElapsedMs;
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
    "bg-sw-surface px-3 py-2",
    // Branch row under a parallel group: gently inset so the nesting reads,
    // but otherwise identical to a linear step row (no accent highlight).
    indent && "ml-4",
  );

  // Lead with the node's real handler type (llm / tool / human / parallel / …)
  // so a tool step reads as a tool, not an llm. Falls back to the neutral icon
  // when the type is unknown (no workflow source, summariser synthetic node).
  const TypeIcon = nodeTypeIcon(nodeType);
  return (
    <div data-testid={`step-${step.stepIdx}`} data-branch={indent ? "true" : undefined} className={rowGridClass}>
      <span className="text-sm font-semibold text-sw-text truncate flex items-center gap-2">
        <TypeIcon className="size-3.5 shrink-0 text-sw-muted" aria-hidden />
        <span className="truncate">{step.nodeId}</span>
        {/* Model the step ran on — only llm steps carry one. */}
        {step.model && <ModelBadge provider={step.provider} model={step.model} className="text-sw-xs" />}
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
          <span className={metricChipClass} title="cost">
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
                <span className="text-sw-muted">Total cost</span>
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
