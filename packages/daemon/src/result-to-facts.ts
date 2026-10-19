// Translate a HandlerResult + intent decision into the FactEvent batch that
// the executor will commit in one appendFact. Side-effect facts
// (intent / done / failed) are NOT included — they're already durable via
// the pre-commit recorder before this function runs.

import { clipPayloadText, getRetry, isTerminalNextNode, readGoalGateRetries } from "@fragua/core";
import type * as handler from "@fragua/core/handler";
import type { FactEvent, RunState } from "@fragua/store";
import { passField } from "./executor-helpers.ts";
import { maxLoopsPause } from "./predispatch-planner.ts";

type HandlerResult = handler.HandlerResult;

export interface ResultContext {
  state: RunState;
  /** Intents folded before the handler ran; we cite them in intents_folded. */
  appliedIntentSeqs: number[];
  /** For cancel: the seq of the cancel intent. */
  cancelIntentSeq?: number;
  /** This turn's accrued spend, for halts that bypass both
   * `fact.node_completed` and `fact.node_aborted` (route_not_picked /
   * route_call_not_isolated / edge_no_match, handler-returned error or
   * budget halts). The halt arm surfaces it as `partial*` fields on
   * `fact.run_terminated{status:errored}` — mirroring `exitSpendFacts` — so the reducer
   * folds the halted turn into `run_state.metrics` instead of dropping
   * it. The pause translations and non-halt arms ignore it (their fact
   * lists either carry a spend-bearing `fact.node_completed` already or
   * the run resumes and the spend lands on a later fact). */
  usage?: HaltUsage;
}

/** Turn-spend shape the halt arm reads. Structurally satisfied by both the
 * executor's `UsageTotals` and the planner's `TurnAccounting` (bucket-cost
 * splits optional — the `addUsage` lane has no bucket-cost source). */
export interface HaltUsage {
  turnBilled: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalInputCostUsd?: number;
  totalOutputCostUsd?: number;
  totalCacheReadCostUsd?: number;
  totalCacheWriteCostUsd?: number;
}

/**
 * Facts to emit AFTER a handler completes successfully.
 *
 * We never call this when the handler threw, leaked, or was aborted mid-flight;
 * those exits go through `planExit` instead.
 */
export function resultToFacts(result: HandlerResult, ctx: ResultContext): FactEvent[] {
  const facts: FactEvent[] = [];

  // Pre-facts: intents_folded + run_resumed if applicable.
  if (ctx.appliedIntentSeqs.length > 0) {
    const folded = ctx.appliedIntentSeqs.join(",");
    for (const seq of ctx.appliedIntentSeqs) {
      facts.push({
        type: "fact.intents_folded",
        payload: { intentSeq: seq, folded },
      });
    }
  }

  // No `fact.run_resumed` emitted here. `wakeHuman` / `wakeResume` /
  // `wakeUnquarantine` already commit the resume fact when the wake
  // intent is processed (see daemon/src/wake-pending.ts) — re-emitting
  // it on dispatch completion was a leftover from M3's earlier design
  // and produced a redundant `fromStatus: "running"` row in the feed.

  // Result-specific facts.
  switch (result.kind) {
    case "transition":
      facts.push(...transitionToFacts(result, ctx));
      return facts;
    case "yield_human":
      facts.push(...yieldHumanToFacts(result, ctx));
      return facts;
    case "halt":
      facts.push(...haltToFacts(result, ctx));
      return facts;
    case "pause_provider":
      facts.push(...pauseProviderToFacts(result, ctx));
      return facts;
  }
}

/** The `transition` arm — `fact.node_completed` (with the token/cost splits)
 * plus the terminal / `node_started` continuation. */
function transitionToFacts(result: Extract<HandlerResult, { kind: "transition" }>, ctx: ResultContext): FactEvent[] {
  const facts: FactEvent[] = [];
  // The executor resolves edge selection before calling resultToFacts,
  // so nextNode is populated by this point. Defaulting to __end__
  // matches the "no outgoing edges" terminal rule if anything upstream
  // missed the substitution.
  const nextNode = result.nextNode ?? "__end__";
  const pass = readGoalGateRetries(ctx.state.routing);
  const payload: Extract<FactEvent, { type: "fact.node_completed" }>["payload"] = {
    nodeId: ctx.state.currentNode ?? "",
    iteration: nodeRetryCount(ctx.state.routing, ctx.state.currentNode ?? ""),
    tokens: result.tokens,
    costUsd: result.costUsd,
    nextNode,
  };
  // Goal-gate re-entry epoch: a retarget pass resets per-node retry
  // counters (§3.4), so `(nodeId, iteration)` alone collides across
  // passes — the epoch keeps each pass's facts distinct.
  Object.assign(payload, passField(pass));
  if (result.modelName != null) payload.modelName = result.modelName;
  if (result.outcomeStatus != null) payload.outcomeStatus = result.outcomeStatus;
  // Route field lands on the fact when a routing node picked a branch —
  // an llm via the synthesised `route` tool, or a judge via
  // `decide.route`. Non-routing nodes leave `result.route` undefined;
  // the field stays absent from the JSON.
  if (result.route != null && result.route.length > 0) payload.route = result.route;
  // Structured outputs: attach unconditionally. The store spills an
  // oversized struct to the blob CAS at append time (the event keeps a tiny
  // `{$fragua_blob}` ref under the 4 KiB cap), so size is no longer a node
  // failure — `result-to-facts` stays a pure size-agnostic projection.
  if (result.outputs !== undefined) {
    payload.outputs = result.outputs as Record<string, unknown>;
  }
  // Input/output/cache split — emit only when non-zero so legacy
  // handlers without the split keep their payload size unchanged
  // (§I7 keeps events ≤4KB).
  if (result.inputTokens != null && result.inputTokens > 0) payload.inputTokens = result.inputTokens;
  if (result.outputTokens != null && result.outputTokens > 0) payload.outputTokens = result.outputTokens;
  if (result.cacheReadTokens != null && result.cacheReadTokens > 0) {
    payload.cacheReadTokens = result.cacheReadTokens;
  }
  if (result.cacheWriteTokens != null && result.cacheWriteTokens > 0) {
    payload.cacheWriteTokens = result.cacheWriteTokens;
  }
  if (result.inputCostUsd != null && result.inputCostUsd > 0) payload.inputCostUsd = result.inputCostUsd;
  if (result.outputCostUsd != null && result.outputCostUsd > 0) payload.outputCostUsd = result.outputCostUsd;
  if (result.cacheReadCostUsd != null && result.cacheReadCostUsd > 0) {
    payload.cacheReadCostUsd = result.cacheReadCostUsd;
  }
  if (result.cacheWriteCostUsd != null && result.cacheWriteCostUsd > 0) {
    payload.cacheWriteCostUsd = result.cacheWriteCostUsd;
  }
  facts.push({ type: "fact.node_completed", payload });

  if (isTerminalNode(nextNode)) {
    // A failure reaches a terminal in two ways, and they mean
    // opposite things:
    //   - `__end__` is the executor's no-fail-route sentinel — the
    //     node failed and the author declared no fail edge. That
    //     halts the run (`aborted_exit`); the reducer maps "halted"
    //     to the UI's "fail" status. The handler's `failureReason`
    //     (e.g. the agent's `<abort>reason</abort>`) surfaces
    //     verbatim as the halt detail.
    //   - An explicit sink (`exit`) reached via a fail edge is a
    //     sanctioned graceful landing the author opted into — the
    //     run completes, not halts.
    if (nextNode === "__end__" && result.outcomeStatus === "fail") {
      const detail =
        typeof result.failureReason === "string" && result.failureReason.length > 0
          ? clipPayloadText(result.failureReason)
          : `node ${ctx.state.currentNode ?? "?"} failed with no fail route`;
      facts.push({
        type: "fact.run_terminated",
        payload: { status: "errored", reason: "aborted_exit", detail },
      });
    } else {
      facts.push({
        type: "fact.run_terminated",
        payload: { status: "completed", finalNode: nextNode },
      });
    }
  } else {
    const startedPayload: Extract<FactEvent, { type: "fact.node_started" }>["payload"] = {
      nodeId: nextNode,
      iteration: nodeRetryCount(ctx.state.routing, nextNode),
    };
    Object.assign(startedPayload, passField(pass));
    facts.push({ type: "fact.node_started", payload: startedPayload });
  }
  return facts;
}

/** The `yield_human` arm — the HITL pause. */
function yieldHumanToFacts(result: Extract<HandlerResult, { kind: "yield_human" }>, ctx: ResultContext): FactEvent[] {
  return [
    {
      type: "fact.run_paused",
      payload: {
        reason: "human",
        nodeId: ctx.state.currentNode ?? "",
        text: result.text,
        routes: result.routes,
        ...(result.routeLabels ? { routeLabels: result.routeLabels } : {}),
      },
    },
  ];
}

/** The `halt` arm — the recoverable-pause translations plus the terminal
 * `fact.run_terminated{errored}` with partial-spend fields. */
function haltToFacts(result: Extract<HandlerResult, { kind: "halt" }>, ctx: ResultContext): FactEvent[] {
  const facts: FactEvent[] = [];
  // Stage 3 of recoverable-budget-pause.md converts three reasons to
  // operator-resumable pauses. `goal_gate_unsatisfied` and `max_loops`
  // still flow through here (the executor sets
  // `result = { kind: "halt", reason: <X> }` at those sites for
  // legibility). `max_retries_exceeded` has migrated to the
  // `retriesExhaustedPause` sentinel in executor.ts and no longer
  // reaches this branch from the executor; the translation below
  // is retained as a safety net for any future caller that still
  // constructs the handler-contract halt shape. Other halts pass
  // through to fact.run_terminated{errored} unchanged.
  const reason = result.reason;
  const nodeId = ctx.state.currentNode ?? "";
  const ctxCurrentLimit = result.pauseContext?.currentLimit ?? 0;
  const ctxAttempts = result.pauseContext?.attempts ?? 0;
  if (reason === "max_retries_exceeded") {
    facts.push({
      type: "fact.run_paused",
      payload: { reason: "max_retries", nodeId, currentLimit: ctxCurrentLimit, attempts: ctxAttempts },
    });
    return facts;
  }
  if (reason === "goal_gate_unsatisfied") {
    // result.detail names the failed gate (set by the executor at
    // the goal_gate halt site). Fall back to the current node when
    // detail is missing — defensive, shouldn't normally fire.
    const gateNodeId = result.detail && result.detail.length > 0 ? result.detail : nodeId;
    facts.push({
      type: "fact.run_paused",
      payload: { reason: "goal_gate", gateNodeId, currentLimit: ctxCurrentLimit },
    });
    return facts;
  }
  if (reason === "max_loops") {
    facts.push(maxLoopsPause({ currentLimit: ctxCurrentLimit, dispatches: ctxAttempts }));
    return facts;
  }
  const payload: Extract<Extract<FactEvent, { type: "fact.run_terminated" }>["payload"], { status: "errored" }> = {
    status: "errored",
    reason,
  };
  if (result.detail != null) payload.detail = clipPayloadText(result.detail);
  // Halts reaching this point bypass fact.node_completed AND
  // fact.node_aborted, so the turn's spend would otherwise vanish
  // from run totals. Surface it as partial* fields (same shape and
  // >0 gating as exitSpendFacts) for the reducer to fold. The
  // budget-halt sentinel path never comes through here (it keeps the
  // transition shape so node_completed lands first), so this cannot
  // double-count a turn.
  const usage = ctx.usage;
  if (usage != null && (usage.turnBilled > 0 || usage.totalCostUsd > 0)) {
    payload.nodeId = nodeId;
    payload.partialTokens = usage.turnBilled;
    payload.partialCostUsd = usage.totalCostUsd;
    if (usage.totalInputTokens > 0) payload.partialInputTokens = usage.totalInputTokens;
    if (usage.totalOutputTokens > 0) payload.partialOutputTokens = usage.totalOutputTokens;
    if (usage.totalCacheReadTokens > 0) payload.partialCacheReadTokens = usage.totalCacheReadTokens;
    if (usage.totalCacheWriteTokens > 0) payload.partialCacheWriteTokens = usage.totalCacheWriteTokens;
    const inputCostUsd = usage.totalInputCostUsd ?? 0;
    const outputCostUsd = usage.totalOutputCostUsd ?? 0;
    const cacheReadCostUsd = usage.totalCacheReadCostUsd ?? 0;
    const cacheWriteCostUsd = usage.totalCacheWriteCostUsd ?? 0;
    if (inputCostUsd > 0) payload.partialInputCostUsd = inputCostUsd;
    if (outputCostUsd > 0) payload.partialOutputCostUsd = outputCostUsd;
    if (cacheReadCostUsd > 0) payload.partialCacheReadCostUsd = cacheReadCostUsd;
    if (cacheWriteCostUsd > 0) payload.partialCacheWriteCostUsd = cacheWriteCostUsd;
  }
  facts.push({ type: "fact.run_terminated", payload });
  return facts;
}

/** The `pause_provider` arm — the turn's spend on `fact.node_aborted`, then the
 * payment-required vs generic provider-error pause. */
function pauseProviderToFacts(
  result: Extract<HandlerResult, { kind: "pause_provider" }>,
  ctx: ResultContext,
): FactEvent[] {
  const nodeId = ctx.state.currentNode ?? "";
  const facts: FactEvent[] =
    ctx.usage !== undefined
      ? exitSpendFacts(
          nodeId,
          nodeRetryCount(ctx.state.routing, nodeId),
          "provider_pause",
          ctx.usage,
          readGoalGateRetries(ctx.state.routing),
        )
      : [];
  // 402 → reason="payment_required" (top-up off-ledger). Anything else
  // in the manual class lands as reason="provider_error"; the
  // executor rewrites to reason="provider_retry" if the
  // provider-retry decision returns auto-retry (transient transport
  // class — 408/429/5xx/529/network).
  if (result.httpStatus === 402) {
    facts.push({
      type: "fact.run_paused",
      payload: {
        reason: "payment_required",
        nodeId,
        provider: result.provider,
        errorMessage: clipPayloadText(result.errorMessage),
      },
    });
    return facts;
  }
  facts.push({
    type: "fact.run_paused",
    payload: {
      reason: "provider_error",
      nodeId,
      httpStatus: result.httpStatus,
      provider: result.provider,
      errorMessage: clipPayloadText(result.errorMessage),
    },
  });
  return facts;
}

/** The one producer of a non-success exit's spend: `fact.node_aborted` carrying
 * the turn's partial usage. Every exit (throw, timeout, abort, shutdown, leak,
 * provider pause) leads with it, on the linear and fan-out paths alike, so the
 * reducer's `node_aborted` fold credits the spend whatever parks the run. */
export function exitSpendFacts(
  nodeId: string,
  iteration: number,
  cause: string,
  partial: HaltUsage,
  pass = 0,
): FactEvent[] {
  const payload: Extract<FactEvent, { type: "fact.node_aborted" }>["payload"] = {
    nodeId,
    iteration,
    cause,
    partialTokens: partial.turnBilled,
    partialCostUsd: partial.totalCostUsd,
  };
  Object.assign(payload, passField(pass));
  if (partial.totalInputTokens > 0) payload.partialInputTokens = partial.totalInputTokens;
  if (partial.totalOutputTokens > 0) payload.partialOutputTokens = partial.totalOutputTokens;
  if (partial.totalCacheReadTokens > 0) payload.partialCacheReadTokens = partial.totalCacheReadTokens;
  if (partial.totalCacheWriteTokens > 0) payload.partialCacheWriteTokens = partial.totalCacheWriteTokens;
  // Per-bucket cost splits keep the analytics invariant (bucket sums ≈
  // total_cost_usd) intact for aborted spend — without them an aborted turn
  // raises the total while the splits stay flat.
  const inputCostUsd = partial.totalInputCostUsd ?? 0;
  const outputCostUsd = partial.totalOutputCostUsd ?? 0;
  const cacheReadCostUsd = partial.totalCacheReadCostUsd ?? 0;
  const cacheWriteCostUsd = partial.totalCacheWriteCostUsd ?? 0;
  if (inputCostUsd > 0) payload.partialInputCostUsd = inputCostUsd;
  if (outputCostUsd > 0) payload.partialOutputCostUsd = outputCostUsd;
  if (cacheReadCostUsd > 0) payload.partialCacheReadCostUsd = cacheReadCostUsd;
  if (cacheWriteCostUsd > 0) payload.partialCacheWriteCostUsd = cacheWriteCostUsd;
  return [{ type: "fact.node_aborted", payload }];
}

type PartialSpendPayload = {
  nodeId?: string;
  partialTokens?: number;
  partialCostUsd?: number;
  partialInputTokens?: number;
  partialOutputTokens?: number;
  partialCacheReadTokens?: number;
  partialCacheWriteTokens?: number;
  partialInputCostUsd?: number;
  partialOutputCostUsd?: number;
  partialCacheReadCostUsd?: number;
  partialCacheWriteCostUsd?: number;
};

const PARTIAL_SPEND_KEYS = [
  "nodeId",
  "partialTokens",
  "partialCostUsd",
  "partialInputTokens",
  "partialOutputTokens",
  "partialCacheReadTokens",
  "partialCacheWriteTokens",
  "partialInputCostUsd",
  "partialOutputCostUsd",
  "partialCacheReadCostUsd",
  "partialCacheWriteCostUsd",
] as const;

function partialSpendOf(fact: FactEvent): PartialSpendPayload | undefined {
  if (fact.type === "fact.run_halted") return fact.payload;
  if (fact.type === "fact.run_terminated" && fact.payload.status === "errored") return fact.payload;
  return undefined;
}

function hasSpend(usage: HaltUsage): boolean {
  return usage.turnBilled > 0 || usage.totalCostUsd > 0;
}

/** The spend a planned fact batch carries, as stand-alone `fact.node_aborted`
 * facts tagged `cause` — what an exit that discards the batch (an OCC ceiling, a
 * crash, a losing fan-out disposition) commits instead so the spend lands
 * exactly once. A `node_completed` converts to its `node_aborted` twin, a
 * `node_aborted` passes through, a halt's `partial*` fields split out (keyed on
 * its `nodeId`, at `at`'s iteration / pass); zero-spend facts and everything
 * else drop. Pure. */
export function spendFactsFor(
  facts: readonly FactEvent[],
  cause: string,
  at: { iteration: number; pass: number } = { iteration: 0, pass: 0 },
): FactEvent[] {
  const out: FactEvent[] = [];
  for (const f of facts) {
    if (f.type === "fact.node_aborted") {
      if (f.payload.partialTokens > 0 || f.payload.partialCostUsd > 0) out.push(f);
      continue;
    }
    if (f.type === "fact.node_completed") {
      const p = f.payload;
      const usage: HaltUsage = {
        turnBilled: p.tokens,
        totalCostUsd: p.costUsd,
        totalInputTokens: p.inputTokens ?? 0,
        totalOutputTokens: p.outputTokens ?? 0,
        totalCacheReadTokens: p.cacheReadTokens ?? 0,
        totalCacheWriteTokens: p.cacheWriteTokens ?? 0,
        totalInputCostUsd: p.inputCostUsd ?? 0,
        totalOutputCostUsd: p.outputCostUsd ?? 0,
        totalCacheReadCostUsd: p.cacheReadCostUsd ?? 0,
        totalCacheWriteCostUsd: p.cacheWriteCostUsd ?? 0,
      };
      if (hasSpend(usage)) out.push(...exitSpendFacts(p.nodeId, p.iteration, cause, usage, p.pass ?? 0));
      continue;
    }
    const p = partialSpendOf(f);
    if (p === undefined) continue;
    const usage: HaltUsage = {
      turnBilled: p.partialTokens ?? 0,
      totalCostUsd: p.partialCostUsd ?? 0,
      totalInputTokens: p.partialInputTokens ?? 0,
      totalOutputTokens: p.partialOutputTokens ?? 0,
      totalCacheReadTokens: p.partialCacheReadTokens ?? 0,
      totalCacheWriteTokens: p.partialCacheWriteTokens ?? 0,
      totalInputCostUsd: p.partialInputCostUsd ?? 0,
      totalOutputCostUsd: p.partialOutputCostUsd ?? 0,
      totalCacheReadCostUsd: p.partialCacheReadCostUsd ?? 0,
      totalCacheWriteCostUsd: p.partialCacheWriteCostUsd ?? 0,
    };
    if (hasSpend(usage)) out.push(...exitSpendFacts(p.nodeId ?? "", at.iteration, cause, usage, at.pass));
  }
  return out;
}

/** The fact with any halt `partial*` spend (and its `nodeId` key) stripped —
 * the disposition half of a halt whose spend `spendFactsFor` split out. Other
 * facts return unchanged. */
export function withoutSpend(fact: FactEvent): FactEvent {
  if (partialSpendOf(fact) === undefined) return fact;
  const payload: Record<string, unknown> = { ...fact.payload };
  for (const k of PARTIAL_SPEND_KEYS) delete payload[k];
  return { ...fact, payload } as FactEvent;
}

export function cancelToFacts(intentSeq: number): FactEvent[] {
  return [{ type: "fact.run_terminated", payload: { status: "aborted", intentSeq } }];
}

/** Per-node retry counter — bumped each time a
 * backward edge re-enters a node after a non-success outcome. Stored
 * per node at `internal.retry_count.<nodeId>` (retryCountKey); the
 * executor writes it and reads it for the dispatch iteration, so the
 * two stay in sync. Typed read via the `getRetry` accessor. */
function nodeRetryCount(routing: Record<string, unknown>, nodeId: string): number {
  return getRetry(routing).count(nodeId);
}

/** See `isTerminalNextNode` in `@fragua/core` — the one predicate both this
 * fold and the transition planner use. Without a graph in hand this arm
 * relies on the parser pinning the name `exit` to `type: exit` (E028). */
function isTerminalNode(nodeId: string): boolean {
  return isTerminalNextNode(nodeId, null);
}
