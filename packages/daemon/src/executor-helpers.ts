// Executor leaf helpers — pure, dependency-light functions extracted from
// executor.ts so they can be unit-tested in isolation and reused across the
// executor's internal modules. Nothing here touches ExecutorOpts, the store,
// or runOne's closure state; everything is a pure transformation of its
// arguments (the lone exceptions, `sleep` and `recordEdgeSelected`, take their
// effect target as a parameter). executor.ts re-exports the public ones
// (classifyAbortCause, buildSubstitutionArgs, resolveBackoff) for compatibility.

import {
  BUDGET_WARNED_KEY,
  type EdgeSelection,
  type GraphAttrs,
  getBudget,
  getInputs,
  getRetry,
  INPUTS_KEY,
  type InputDecl,
  isRetryPresetName,
  MAX_GOAL_GATE_RETRIES_OVERRIDE_KEY,
  MAX_LOOPS_OVERRIDE_KEY,
  maxRetriesOverrideKey,
  type NodeAttrs,
  type OutputsValue,
  RETRY_PRESETS,
  resolveInputBindings,
  routingString,
  type SubstitutionArgs,
} from "@fragua/core";
import type * as core from "@fragua/core/handler";
import { SETTLED_STATUSES } from "@fragua/store";

/** Settled statuses — the run has stopped progressing on its own (terminal
 * OR quarantined). Drives worktree dispose + the terminal snapshot gate.
 * Derived from the canonical {@link SETTLED_STATUSES} tuple so it can't drift
 * (quarantined is settled-but-resumable; paused_human is excluded — the env
 * survives across HITL pauses for reuse on resume). */
export const TERMINAL_STATUSES = new Set<string>(SETTLED_STATUSES);

// The routing-key vocabulary (`BUDGET_WARNED_KEY`, `MAX_LOOPS_OVERRIDE_KEY`,
// `MAX_GOAL_GATE_RETRIES_OVERRIDE_KEY`, `maxRetriesOverrideKey`, …) is the typed
// -routing accessor module's single source of truth (`@fragua/core`). Re-export
// the ones daemon-internal callers import from here, so their import source is
// stable.
export {
  BUDGET_WARNED_KEY,
  MAX_GOAL_GATE_RETRIES_OVERRIDE_KEY,
  MAX_LOOPS_OVERRIDE_KEY,
  maxRetriesOverrideKey,
  routingString,
};

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Sentinel returned by the leak-detection timer in `Promise.race` so
 * the executor can tell "the handler ignored its AbortSignal past
 * `maxMs + leakGrace`" from "the handler rejected normally" (which goes
 * through the catch branch). Symbol equality is the only check needed —
 * no risk of a handler returning the same value. */
export const TIMEOUT_SENTINEL: unique symbol = Symbol("timeout-sentinel");
export type TimeoutSentinel = typeof TIMEOUT_SENTINEL;

export function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === "AbortError" || err.name === "TimeoutError";
  }
  return false;
}

/**
 * Decide whether an abort was due to the node's own maxMs deadline
 * or an operator / shutdown / steer signal. Reads `signal.reason`
 * first (set by the aborting source via `AbortSignal.any`'s
 * reason-propagation) and falls back to the thrown error's name.
 * A TimeoutError reason indicates the `AbortSignal.timeout(maxMs)`
 * branch tripped; any other error name means an explicit abort
 * tripped first.
 */
export function classifyAbortCause(signal: AbortSignal, err: unknown): "timeout" | "aborted" {
  const reason = signal.aborted ? signal.reason : undefined;
  if (reason instanceof Error && reason.name === "TimeoutError") return "timeout";
  if (err instanceof Error && err.name === "TimeoutError") return "timeout";
  return "aborted";
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Read the per-node retry counter from routing, bumped each time a backward edge re-enters a node after a
 * non-success outcome. Stored at `internal.retry_count.<nodeId>`
 * (retryCountKey) — the same key the retry-policy block writes; the
 * dispatch iteration reads it so a re-entered node carries the right
 * iteration through node_started / dispatch_started / node_completed.
 * Typed read via the `getRetry` accessor. */
export function nodeRetryCount(routing: Record<string, unknown>, nodeId: string): number {
  return getRetry(routing).count(nodeId);
}

export type ResumeOf = "fresh" | "crash" | "paused" | "paused_human" | "paused_auto" | "quarantined";

/** Determine why this dispatch is starting, for fact.dispatch_started's
 * resumeOf field. Walks the latest facts looking for the one that
 * flipped the run back to a dispatchable state:
 *   fact.run_resumed{fromStatus} → forward fromStatus
 *   fact.run_requeued_after_crash → "crash"
 *   any other fact (run_started, dispatch_started, node_*) → "fresh"
 *
 * The walk stops at the first significant fact, so a resume followed
 * by a node hop produces "fresh" — the resume only labels the
 * immediately-following dispatch. Provenance for downstream analytics
 * still lives on fact.run_resumed.fromStatus.
 *
 * Uses getLatestEvents (DESC + LIMIT) rather than the prior
 * getEvents(limit: 20) call: that one ordered ASC, so on any run
 * with >20 events the lookback fetched the EARLIEST 20 events and
 * always missed fact.run_resumed → always returned "fresh". */
export function deriveResumeOf(
  store: { getLatestEvents: (runId: string, limit: number) => Array<{ type: string; payload: unknown }> },
  runId: string,
): ResumeOf {
  const recent = store.getLatestEvents(runId, 20);
  for (const e of recent) {
    if (e == null) continue;
    if (e.type === "fact.run_resumed") {
      const fs = (e.payload as { fromStatus?: string } | null)?.fromStatus;
      if (fs === "paused" || fs === "paused_human" || fs === "paused_auto" || fs === "quarantined") return fs;
      return "fresh";
    }
    if (e.type === "fact.run_requeued_after_crash") return "crash";
    if (e.type.startsWith("fact.")) return "fresh";
  }
  return "fresh";
}

/** The once-per-run `budget.warn` dedup tag set. Typed read via `getBudget`. */
export function readBudgetWarned(routing: Record<string, unknown>): ReadonlySet<string> {
  return getBudget(routing).warned;
}

/** Read operator-supplied budget overrides from `routing.budget_override.<scope>.<metric>`
 * (folded by intent-fold from `intent.budget_adjusted`). Returns undefined when
 * no overrides are set; the budget policy falls back to graph/node attrs.
 * Typed read via `getBudget`. */
export function readBudgetOverrides(routing: Record<string, unknown>):
  | {
      run?: { cost?: number; tokens?: number };
      node?: { cost?: number; tokens?: number };
    }
  | undefined {
  const b = getBudget(routing);
  const runCost = b.override("run", "cost");
  const runTokens = b.override("run", "tokens");
  const nodeCost = b.override("node", "cost");
  const nodeTokens = b.override("node", "tokens");
  const hasRun = runCost !== undefined || runTokens !== undefined;
  const hasNode = nodeCost !== undefined || nodeTokens !== undefined;
  if (!hasRun && !hasNode) return undefined;
  const out: { run?: { cost?: number; tokens?: number }; node?: { cost?: number; tokens?: number } } = {};
  if (hasRun) {
    const run: { cost?: number; tokens?: number } = {};
    if (runCost !== undefined) run.cost = runCost;
    if (runTokens !== undefined) run.tokens = runTokens;
    out.run = run;
  }
  if (hasNode) {
    const node: { cost?: number; tokens?: number } = {};
    if (nodeCost !== undefined) node.cost = nodeCost;
    if (nodeTokens !== undefined) node.tokens = nodeTokens;
    out.node = node;
  }
  return out;
}

/**
 * Stamp the selected edge into the observability buffer so the UI and
 * replay tools see exactly which rule picked the traversal. `edge.selected`
 * is in the core EventType union; emitted alongside `fact.node_completed`
 * at commit time.
 */
export function recordEdgeSelected(
  buffer: { type: string; payload: Record<string, unknown> }[],
  fromNode: string,
  iteration: number,
  selection: EdgeSelection,
  pass = 0,
): void {
  const payload: Record<string, unknown> = {
    from: fromNode,
    to: selection.edge.to,
    iteration,
    ...passField(pass),
    rule: selection.rule,
  };
  if (selection.matched !== undefined) {
    payload["matched"] = selection.matched;
  }
  buffer.push({ type: "edge.selected", payload });
}

export function buildSubstitutionArgs(
  routing: Record<string, unknown>,
  inputDecls?: readonly InputDecl[],
  resolvedOutputs?: Record<string, OutputsValue>,
): SubstitutionArgs {
  const args: SubstitutionArgs = {};
  // `${{ inputs.x }}` bindings: declared defaults overlaid by the run's
  // provided `routing.inputs` map (set at enqueue from `--input k=v`).
  const resolved = resolveInputBindings(inputDecls, getInputs(routing));
  if (Object.keys(resolved).length > 0) args.inputs = resolved;
  // `${{ outputs.X.f }}` bindings: pre-fetched from the outputs index.
  if (resolvedOutputs !== undefined && Object.keys(resolvedOutputs).length > 0) {
    args.outputs = resolvedOutputs;
  }
  return args;
}

/** Read a `routing.inputs` VALUE map preserving object / array input values.
 * Thin wrapper over the `getInputs` accessor (which owns the three guards: the
 * `__proto__` key filter, the un-materialized `$fragua_blob` ref drop, and
 * object-or-`{}`) for callers that hold the inputs value rather than the whole
 * routing object. */
export function readInputMap(v: unknown): Record<string, unknown> {
  return getInputs({ [INPUTS_KEY]: v });
}

/** The canonical spread for stamping the goal-gate re-entry epoch on a fact
 * payload — omitted at 0 so never-retargeted runs stay byte-identical. Every
 * lifecycle emit site carries it; one helper keeps a new fact type from
 * silently dropping the epoch (which corrupts pass-keyed projections). */
export function passField(pass: number): Record<string, never> | { pass: number } {
  return pass > 0 ? { pass } : {};
}

export function readNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** A clearable replacement for `AbortSignal.timeout(ms)`: a plain setTimeout
 * aborting with a TimeoutError-named reason (so `classifyAbortCause` still
 * reads "timeout") plus a disarm. AbortSignal.timeout's timer is
 * uncancellable — armed per dispatch it kept the composite signal, and every
 * abort listener's closure hanging off it, reachable for the FULL deadline
 * after a seconds-long dispatch settled; a wide fan-out multiplied that by
 * branches × supersteps. */
/** A releasable `AbortSignal.any`: same first-source-wins composite, plus a
 * `release()` that removes the source listeners WITHOUT mutating signal
 * state (safe to call after the dispatch settles, before/after
 * `classifyAbortCause` reads the composite). `AbortSignal.any` itself pins
 * the composite — and every closure hanging off it — on each source until
 * that source aborts; with `opts.shutdownSignal` as a source, every branch
 * ever dispatched stayed reachable for the daemon's lifetime. */
export function composeAbortSignals(sources: AbortSignal[]): { signal: AbortSignal; release: () => void } {
  const ctrl = new AbortController();
  const offs: Array<() => void> = [];
  for (const s of sources) {
    if (s.aborted) {
      if (!ctrl.signal.aborted) ctrl.abort(s.reason);
      break;
    }
    const fn = (): void => {
      if (!ctrl.signal.aborted) ctrl.abort(s.reason);
    };
    s.addEventListener("abort", fn, { once: true });
    offs.push(() => s.removeEventListener("abort", fn));
  }
  return {
    signal: ctrl.signal,
    release: (): void => {
      for (const off of offs) off();
    },
  };
}

export function armTimeout(ms: number): { signal: AbortSignal; disarm: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    const err = new Error(`dispatch deadline exceeded (${ms}ms)`);
    err.name = "TimeoutError";
    ctrl.abort(err);
  }, ms);
  return { signal: ctrl.signal, disarm: () => clearTimeout(timer) };
}

/** Per-dispatch usage totals — the shape `planTransition` takes verbatim as
 * its `accounting` input. `lastModel` is explicitly `string | undefined`
 * (not optional) so the object spreads cleanly under
 * `exactOptionalPropertyTypes`. */
export interface UsageTotals {
  turnBilled: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /** Per-bucket COST splits, fed by the `cost.recorded` mirror (the llm
   * handler-bridge path). The `addUsage` lane has no bucket-cost source
   * (LlmAccounting carries token splits only), so spend routed through
   * `ctx.llm.call` lands in `totalCostUsd` with these at 0 — the analytics
   * rollup treats the shortfall as unsplit residual. */
  totalInputCostUsd: number;
  totalOutputCostUsd: number;
  totalCacheReadCostUsd: number;
  totalCacheWriteCostUsd: number;
  lastModel: string | undefined;
}

/** Per-dispatch usage accumulator shared by the linear and fan-out branch
 * kernels: the `addUsage` sink for `ctx.llm` plus the `cost.recorded` mirror
 * for llm handlers that bypass `ctx.llm.call()` (the handler-bridge forwards
 * every pi-agent-core message_end → cost.recorded; without the mirror the
 * abort arm's partial payload reads zero and run_state.metrics undercounts
 * aborted spend). The two kernels carried character-identical copies of this
 * closure, and the pair had already drifted once before — one accumulator
 * makes the next usage field land on both paths by construction. */
export function makeUsageAccumulator(): {
  accounting: core.LlmAccounting;
  mirrorCostRecorded(payload: Record<string, unknown>): void;
  totals(): Readonly<UsageTotals>;
} {
  const t: UsageTotals = {
    turnBilled: 0,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalInputCostUsd: 0,
    totalOutputCostUsd: 0,
    totalCacheReadCostUsd: 0,
    totalCacheWriteCostUsd: 0,
    lastModel: undefined,
  };
  return {
    accounting: {
      addUsage: ({ tokens, costUsd, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }) => {
        t.turnBilled += tokens;
        t.totalCostUsd += costUsd;
        t.totalInputTokens += inputTokens ?? 0;
        t.totalOutputTokens += outputTokens ?? 0;
        t.totalCacheReadTokens += cacheReadTokens ?? 0;
        t.totalCacheWriteTokens += cacheWriteTokens ?? 0;
        t.lastModel = model;
      },
    },
    mirrorCostRecorded: (p) => {
      t.turnBilled += readNumber(p["total_tokens"]);
      t.totalCostUsd += readNumber(p["cost_usd"]);
      t.totalInputTokens += readNumber(p["input_tokens"]);
      t.totalOutputTokens += readNumber(p["output_tokens"]);
      t.totalCacheReadTokens += readNumber(p["cache_read_tokens"]);
      t.totalCacheWriteTokens += readNumber(p["cache_write_tokens"]);
      t.totalInputCostUsd += readNumber(p["cost_input_usd"]);
      t.totalOutputCostUsd += readNumber(p["cost_output_usd"]);
      t.totalCacheReadCostUsd += readNumber(p["cost_cache_read_usd"]);
      t.totalCacheWriteCostUsd += readNumber(p["cost_cache_write_usd"]);
      const model = p["model"];
      if (typeof model === "string") t.lastModel = model;
    },
    totals: () => t,
  };
}

/** Resolve the effective BackoffConfig for a node from
 * (node.retry_policy → graph.default_retry_policy → "none") plus the
 * custom-override attrs (retry_initial_delay_ms / retry_backoff_factor /
 * retry_max_delay_ms / retry_jitter). Unknown preset names silently fall
 * back to "none" (validator W014 surfaces the typo at author time). */
export function resolveBackoff(
  nodeAttrs: NodeAttrs,
  graphAttrs: GraphAttrs,
): {
  initialDelayMs: number;
  backoffFactor: number;
  maxDelayMs: number;
  jitter: boolean;
} {
  const nodeName = (nodeAttrs as Record<string, unknown>)["retry_policy"];
  const graphName = (graphAttrs as Record<string, unknown>)["default_retry_policy"];
  const presetName = isRetryPresetName(nodeName) ? nodeName : isRetryPresetName(graphName) ? graphName : "none";
  const base = RETRY_PRESETS[presetName];
  const n = nodeAttrs as Record<string, unknown>;
  return {
    initialDelayMs: typeof n["retry_initial_delay_ms"] === "number" ? n["retry_initial_delay_ms"] : base.initialDelayMs,
    backoffFactor: typeof n["retry_backoff_factor"] === "number" ? n["retry_backoff_factor"] : base.backoffFactor,
    maxDelayMs: typeof n["retry_max_delay_ms"] === "number" ? n["retry_max_delay_ms"] : base.maxDelayMs,
    jitter: typeof n["retry_jitter"] === "boolean" ? n["retry_jitter"] : base.jitter,
  };
}

/** Resolve max_retries. Returns `node.max_retries` if set, else 0. */
export function resolveMaxRetries(nodeAttrs: NodeAttrs, _graphAttrs: GraphAttrs): number {
  if (typeof nodeAttrs.max_retries === "number") return Math.max(0, Math.floor(nodeAttrs.max_retries));
  return 0;
}

export function mergeRoutingPatches(
  fromIntents: Record<string, unknown>,
  _result: core.HandlerResult,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = { ...fromIntents };
  return Object.keys(merged).length > 0 ? merged : undefined;
}
