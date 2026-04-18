// Main execution loop. Pure orchestration: parses, validates, dispatches to
// handlers, emits events, and returns an ExecutionResult. No I/O.
//
// See docs/SPEC.md §4.

import { BudgetLedger, type BudgetLimits, type BudgetQuery, costDeltaFromEvent } from "../engine/budget.ts";
import { type EdgeSelection, selectEdge } from "../engine/edge-selection.ts";
import { degradeOnResume, resolveFidelity, resolveThreadId } from "../engine/fidelity.ts";
import { applyStylesheet } from "../engine/stylesheet.ts";
import { type NodeOutput, type SubstitutionArgs, substitute } from "../engine/substitution.ts";
import { type EventSink, InMemorySink } from "../events/sink.ts";
import { AutoApproveInterviewer } from "../interviewer/index.ts";
import { CHECKPOINT_SCHEMA_VERSION, type Checkpoint, type CheckpointStore } from "../types/checkpoint.ts";
import { type ContextMap, ENGINE_CONTEXT_KEYS, retryCountKey } from "../types/context.ts";
import {
  type ControlRequest,
  EVENT_SCHEMA_VERSION,
  type Event,
  type EventType,
  type NodeStartedData,
} from "../types/events.ts";
import type { FidelityMode } from "../types/fidelity.ts";
import { type Graph, handlerOf, isTerminal, type Node } from "../types/graph.ts";
import type { Interviewer, Question } from "../types/interviewer.ts";
import { type ContextValue, fail, type Outcome, ok } from "../types/outcome.ts";
import { type SummariserBackend, titleSyntheticNodeId } from "../types/summariser.ts";

// ---------------------------------------------------------------------------
// Ports + types

export interface CodergenBackend {
  run(input: CodergenInput): Promise<Outcome>;
  /** Wave 6 checkpoint bridge: serialise any in-memory per-thread
   * transcript state so the executor can stamp it onto
   * `checkpoint.pi_sessions`. Optional — backends without a session
   * store just omit this and the field stays empty. */
  serialiseSessions?(): Record<string, unknown>;
  /** Inverse of `serialiseSessions`. Called on resume with the
   * `pi_sessions` field from the loaded checkpoint so prior
   * transcripts rejoin the MessageStore before the first resumed
   * backend.run(). */
  hydrateSessions?(sessions: Record<string, unknown>): void;
  /** Control-channel hook: inject `message` as a user turn into the
   * currently-running agent, or buffer it for the next `run()` call when
   * no agent is active. Called by the executor's control loop when a
   * `control.steer` request arrives. Optional — backends that don't
   * support mid-run steering (e.g. the mock backend) can omit it. */
  steer?(message: string): void;
}

export interface CodergenInput {
  node: Node;
  prompt: string;
  context: ContextMap;
  thread_id: string | undefined;
  fidelity: FidelityMode;
  signal: AbortSignal;
  /** Run id + workflow sha in case the backend emits events itself. */
  run_id: string;
  workflow_sha: string;
  /** Optional sink bridge — backends call this to emit sub-events
   * (agent.*, llm.*, tool.execution_*) during the node's execution. */
  emit?: (type: EventType, data: Record<string, unknown>) => Promise<void>;
  /** Same as `emit` but with an explicit `node_id` override on the
   * envelope — for synthetic-node events (Wave 2b summariser, future
   * tool-hook events) that shouldn't be attributed to the caller. */
  emitAt?: (type: EventType, data: Record<string, unknown>, node_id: string) => Promise<void>;
  /** Loop iteration metadata when invoked from a loop handler. The backend
   * forwards this verbatim onto `llm.start.iteration` so every per-iteration
   * call is distinguishable in `events.jsonl` without reconstructing
   * sequence from `node.retrying` events. */
  iteration?: { n: number; max: number };
  /** Wave 4 budget context: cumulative cost/tokens so far plus the
   * per-node and per-run ceilings. Backends use this both to populate
   * `llm.start.budget` with real values and to pre-flight-refuse a call
   * that would breach a `stop` policy. `undefined` when no budget is
   * configured anywhere. */
  budget?: BudgetQuery;
  /** Whether a breach has already triggered a stop. Backends must
   * fail non-retryably on `true` even before inspecting `budget.*`
   * (handles the case where the ledger crossed during a summariser
   * call on the same node). */
  budget_stopped?: boolean;
}

export interface HandlerContext {
  node: Node;
  graph: Graph;
  context: ContextMap;
  run_id: string;
  workflow_sha: string;
  sink: EventSink;
  interviewer: Interviewer;
  backend: CodergenBackend;
  signal: AbortSignal;
  now: () => string;
  random: () => number;
  node_outputs: Map<string, NodeOutput>;
  /** Positional args / built-in vars for prompt substitution ($ARGUMENTS, $1..$9). */
  args: SubstitutionArgs;
  /** Wave 4 ledger. Shared across handlers in the run so per-node and
   * per-run cumulatives stay in lockstep. `undefined` when no budget
   * is configured anywhere (saves us the ledger's book-keeping cost
   * on runs that don't need it). */
  ledger?: BudgetLedger;
  /** Wave 4: mutable flag the executor flips when the ledger emits
   * budget.stop. Backends read this off `CodergenInput.budget_stopped`
   * and refuse pre-flight when true. */
  budgetStoppedRef?: { stopped: boolean };
  /** Wave 6 resume degradation: node ids whose next codergen call
   * should have its resolved fidelity run through `degradeOnResume`
   * (SPEC §3.6). Populated on resume with the checkpoint's
   * `current_node`; the codergen handler clears the entry after use. */
  resumeDegradedNodes?: Set<string>;
}

export type Handler = (ctx: HandlerContext) => Promise<Outcome>;

export interface ExecutionResult {
  run_id: string;
  workflow_sha: string;
  outcome: Outcome;
  completed_nodes: string[];
  node_outcomes: Record<string, Outcome>;
  context: ContextMap;
  goal_gates_satisfied: boolean;
}

// ---------------------------------------------------------------------------
// Mock backend

/** A CodergenBackend driven by a programmable function. */
export class MockCodergenBackend implements CodergenBackend {
  constructor(
    private readonly fn: (input: CodergenInput) => Promise<Outcome> | Outcome = (input) =>
      ok({ notes: `mock output for ${input.node.id}` }),
  ) {}

  async run(input: CodergenInput): Promise<Outcome> {
    return await this.fn(input);
  }
}

// ---------------------------------------------------------------------------
// Handlers

const startHandler: Handler = async () => ok({ notes: "start" });
const exitHandler: Handler = async () => ok({ notes: "exit" });
/** Pass-through; edge conditions are evaluated by the executor. */
const conditionalHandler: Handler = async () => ok({ notes: "conditional" });

/** Parse a timeout attr — accepts a number (ms) or a string like "30s" / "2m" / "500ms". */
function parseTimeoutMs(raw: unknown): number | undefined {
  if (typeof raw === "number") return raw > 0 ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m)?\s*$/i.exec(raw);
  if (!match) return undefined;
  const n = Number.parseFloat(match[1]!);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = (match[2] ?? "ms").toLowerCase();
  return unit === "m" ? n * 60_000 : unit === "s" ? n * 1_000 : n;
}

/** Return an AbortSignal that fires when either the parent aborts or `ms` elapses. */
function signalWithTimeout(parent: AbortSignal, ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const onParent = (): void => ctrl.abort();
  if (parent.aborted) ctrl.abort();
  else parent.addEventListener("abort", onParent, { once: true });
  const timer = setTimeout(() => ctrl.abort(), ms);
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParent);
    },
  };
}

function buildEmit(ctx: HandlerContext): (type: EventType, data: Record<string, unknown>) => Promise<void> {
  return async (type, data) => {
    const ev: Event = {
      run_id: ctx.run_id,
      node_id: ctx.node.id,
      type,
      timestamp: ctx.now(),
      workflow_sha: ctx.workflow_sha,
      schema_version: EVENT_SCHEMA_VERSION,
      data,
    };
    await ctx.sink.append(ev);
  };
}

/** Spawn an async pipeline-title summariser call. Returns a promise the
 * executor awaits just before closing the run so the generated-title
 * event lands before `pipeline.completed`. Never rejects — all failure
 * modes are captured on `summary.completed.error` (emitted by the
 * summariser itself) or silently dropped when no summariser is wired. */
async function maybeStartPipelineTitle(params: {
  summariser: SummariserBackend | undefined;
  args: SubstitutionArgs;
  graph: Graph;
  run_id: string;
  workflow_sha: string;
  now: () => string;
  sink: EventSink;
  context: ContextMap;
  auto_title: "on" | "off" | undefined;
  signal: AbortSignal;
}): Promise<void> {
  const graphAutoTitleRaw = params.graph.attrs["auto_title"];
  const graphAutoTitle =
    typeof graphAutoTitleRaw === "string" ? (graphAutoTitleRaw === "off" ? "off" : "on") : undefined;
  const effective = graphAutoTitle ?? params.auto_title ?? "on";
  if (effective !== "on") return;
  if (!params.summariser) return;

  // $ARGUMENTS is the canonical "what did the user ask the pipeline to do"
  // — that's what we want to title. Fall back to joining $1..$9 when the
  // caller populated those but not $ARGUMENTS.
  const args = params.args;
  const sourceText = (
    args.$ARGUMENTS ??
    [args.$1, args.$2, args.$3, args.$4, args.$5, args.$6, args.$7, args.$8, args.$9].filter(Boolean).join(" ")
  ).trim();
  if (sourceText.length === 0) return;

  const synthetic = titleSyntheticNodeId();
  const summariser = params.summariser;
  const goalRaw = params.graph.attrs["goal"];
  const goal = typeof goalRaw === "string" && goalRaw.length > 0 ? goalRaw : undefined;
  const emitAt = async (type: EventType, data: Record<string, unknown>, node_id: string): Promise<void> => {
    const ev: Event = {
      run_id: params.run_id,
      node_id,
      type,
      timestamp: params.now(),
      workflow_sha: params.workflow_sha,
      schema_version: EVENT_SCHEMA_VERSION,
      data,
    };
    await params.sink.append(ev);
  };

  try {
    const result = await summariser.summarise({
      purpose: "title",
      input: sourceText,
      ...(goal !== undefined ? { goal } : {}),
      run_id: params.run_id,
      workflow_sha: params.workflow_sha,
      synthetic_node_id: synthetic,
      max_output_tokens: 40,
      emit: emitAt,
      signal: params.signal,
    });
    if (result.ok && result.text.length > 0) {
      const title = result.text.replace(/^["']|["']$/g, "").trim();
      params.context["graph.title"] = title;
      await emitAt("pipeline.title_generated", { title, summary_node_id: synthetic }, synthetic);
    }
  } catch {
    // Title is a UX polish; never let it crash the run. `summary.completed`
    // carries the failure reason if the summariser got far enough to emit.
  }
}

/** Resolve the per-node budget limits for a single CodergenInput.
 * Graph-level ceilings (`budget_usd`, `budget_tokens`) apply to every
 * node; node attrs (`max_cost_usd`, `max_tokens`) stack on top. */
function buildBudgetLimits(graph: Graph, node: Node): BudgetLimits {
  const limits: BudgetLimits = {};
  const nc = node.attrs.max_cost_usd;
  const nt = node.attrs.max_tokens;
  const rc = graph.attrs.budget_usd;
  const rt = graph.attrs.budget_tokens;
  if (typeof nc === "number") limits.node_max_cost_usd = nc;
  if (typeof nt === "number") limits.node_max_tokens = nt;
  if (typeof rc === "number") limits.run_max_cost_usd = rc;
  if (typeof rt === "number") limits.run_max_tokens = rt;
  return limits;
}

const BUDGET_SYNTHETIC_NODE_ID = "__budget";

/** True when the graph or any node declares a budget ceiling. We only
 * stand up the BudgetLedger + sink wrapper when there's work to do. */
function hasAnyBudget(graph: Graph): boolean {
  if (typeof graph.attrs.budget_usd === "number" || typeof graph.attrs.budget_tokens === "number") return true;
  for (const node of Object.values(graph.nodes)) {
    if (typeof node.attrs.max_cost_usd === "number" || typeof node.attrs.max_tokens === "number") return true;
  }
  return false;
}

/** Wrap an EventSink so every appended `cost.recorded` feeds the
 * BudgetLedger, and any resulting warn/stop verdict is emitted as its
 * own event under the synthetic `__budget` node. The original append
 * still happens first so the cost event lands before any budget event
 * that reacts to it — keeps the JSONL strictly causal for replay. */
function wrapSinkWithLedger(params: {
  inner: EventSink;
  ledger: BudgetLedger;
  graph: Graph;
  run_id: string;
  workflow_sha: string;
  now: () => string;
  policy: "warn" | "stop";
  stoppedRef: { stopped: boolean };
}): EventSink {
  const { inner, ledger, graph, run_id, workflow_sha, now, policy, stoppedRef } = params;
  return {
    async append(ev: Event): Promise<void> {
      await inner.append(ev);
      if (ev.type !== "cost.recorded") return;
      const delta = costDeltaFromEvent(ev);
      if (!delta) return;
      const node_id = delta.node_id;
      // Synthetic (summariser) nodes don't have their own limits, so
      // apply only the run-level ceilings for their cost.
      const limits: BudgetLimits =
        node_id && graph.nodes[node_id]
          ? buildBudgetLimits(graph, graph.nodes[node_id]!)
          : {
              ...(typeof graph.attrs.budget_usd === "number" ? { run_max_cost_usd: graph.attrs.budget_usd } : {}),
              ...(typeof graph.attrs.budget_tokens === "number" ? { run_max_tokens: graph.attrs.budget_tokens } : {}),
            };
      const verdict = ledger.record(delta, limits);
      if (verdict.kind === "ok") return;
      const baseData: Record<string, unknown> = {
        scope: verdict.scope,
        metric: verdict.metric,
        reason: verdict.reason,
        ...(typeof graph.attrs.budget_usd === "number" ? { run_max_cost_usd: graph.attrs.budget_usd } : {}),
        ...(typeof graph.attrs.budget_tokens === "number" ? { run_max_tokens: graph.attrs.budget_tokens } : {}),
        ...(node_id ? { caller_node_id: node_id } : {}),
      };
      const eventData: Record<string, unknown> = {
        ...baseData,
        limit: verdict.limit,
        actual: verdict.actual,
        ...(verdict.kind === "warn" ? { ratio: verdict.ratio } : {}),
      };
      await inner.append({
        run_id,
        node_id: BUDGET_SYNTHETIC_NODE_ID,
        type: verdict.kind === "warn" ? "budget.warn" : "budget.stop",
        timestamp: now(),
        workflow_sha,
        schema_version: EVENT_SCHEMA_VERSION,
        data: eventData,
      });
      if (verdict.kind === "stop" && policy === "stop") stoppedRef.stopped = true;
    },
    close: inner.close ? () => inner.close!() : undefined,
  } as EventSink;
}

/** Like `buildEmit` but lets the caller override `node_id` per event.
 * Used for synthetic nodes (Wave 2b summariser) whose cost + drilldown
 * should bucket separately from the real caller. */
function buildEmitAt(
  ctx: HandlerContext,
): (type: EventType, data: Record<string, unknown>, node_id: string) => Promise<void> {
  return async (type, data, node_id) => {
    const ev: Event = {
      run_id: ctx.run_id,
      node_id,
      type,
      timestamp: ctx.now(),
      workflow_sha: ctx.workflow_sha,
      schema_version: EVENT_SCHEMA_VERSION,
      data,
    };
    await ctx.sink.append(ev);
  };
}

const codergenHandler: Handler = async (ctx) => {
  const prompt = substitute(ctx.node.attrs.prompt ?? "", {
    context: ctx.context,
    nodeOutputs: ctx.node_outputs,
    args: ctx.args,
  });
  let fidelity = resolveFidelity({ graph: ctx.graph, edge: undefined, targetNode: ctx.node });
  // Wave 6 — SPEC §3.6: the first codergen call for the resumed node
  // degrades its fidelity. Clearing the entry after use means later
  // nodes in the same run run at their declared fidelity.
  if (ctx.resumeDegradedNodes?.has(ctx.node.id)) {
    fidelity = degradeOnResume(fidelity);
    ctx.resumeDegradedNodes.delete(ctx.node.id);
  }
  const thread_id = resolveThreadId({ graph: ctx.graph, edge: undefined, targetNode: ctx.node });

  const timeoutMs = parseTimeoutMs(ctx.node.attrs.timeout);
  const { signal, cancel } =
    timeoutMs !== undefined ? signalWithTimeout(ctx.signal, timeoutMs) : { signal: ctx.signal, cancel: () => {} };

  // Wave 4: snapshot the ledger right before the backend call so the
  // backend can populate `llm.start.budget` with real cumulative values
  // and pre-flight-refuse when `stop` policy + prior breach.
  const budgetLimits = ctx.ledger ? buildBudgetLimits(ctx.graph, ctx.node) : undefined;
  const budgetSnapshot = ctx.ledger && budgetLimits ? ctx.ledger.query(ctx.node.id, budgetLimits) : undefined;
  const budgetStopped = ctx.budgetStoppedRef?.stopped ?? false;

  try {
    const outcome = await ctx.backend.run({
      node: ctx.node,
      prompt,
      context: ctx.context,
      thread_id,
      fidelity,
      signal,
      run_id: ctx.run_id,
      workflow_sha: ctx.workflow_sha,
      emit: buildEmit(ctx),
      emitAt: buildEmitAt(ctx),
      ...(budgetSnapshot !== undefined ? { budget: budgetSnapshot } : {}),
      ...(budgetStopped ? { budget_stopped: true } : {}),
    });
    if (signal.aborted && !ctx.signal.aborted && timeoutMs !== undefined) {
      return fail(`node "${ctx.node.id}" timed out after ${timeoutMs}ms`, { notes: outcome.notes });
    }
    return outcome;
  } catch (err) {
    if (signal.aborted && !ctx.signal.aborted && timeoutMs !== undefined) {
      return fail(`node "${ctx.node.id}" timed out after ${timeoutMs}ms`);
    }
    return fail(`codergen crashed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    cancel();
  }
};

const PROMISE_TAG_RE = /<promise>\s*([A-Z0-9_]+)\s*<\/promise>/g;

/** Loop handler: re-run the codergen body until the assistant's reply contains
 * `<promise>${until}</promise>` or max_iterations is exhausted. Archon-style.
 * The completion tag is stripped from the outcome's `notes`. */
const loopHandler: Handler = async (ctx) => {
  const untilTag = typeof ctx.node.attrs.until === "string" ? ctx.node.attrs.until : undefined;
  if (!untilTag) return fail('loop node missing required attr "until"');
  const maxIter = typeof ctx.node.attrs.max_iterations === "number" ? ctx.node.attrs.max_iterations : 10;
  const fresh = ctx.node.attrs.fresh_context === true;

  const fidelity = resolveFidelity({ graph: ctx.graph, edge: undefined, targetNode: ctx.node });
  const threadBase = resolveThreadId({ graph: ctx.graph, edge: undefined, targetNode: ctx.node });
  const emit = buildEmit(ctx);
  const emitAt = buildEmitAt(ctx);

  const basePrompt = substitute(ctx.node.attrs.prompt ?? "", {
    context: ctx.context,
    nodeOutputs: ctx.node_outputs,
    args: ctx.args,
  });

  const accumulatedUpdates: Record<string, ContextValue> = {};
  let lastOutcome: Outcome = ok();

  for (let i = 1; i <= maxIter; i++) {
    if (ctx.signal.aborted) return fail("aborted");

    await emit("node.retrying", {
      attempt: i,
      max_retries: maxIter,
      delay_ms: 0,
      reason: "loop iteration",
    });

    const iterPrompt =
      i === 1
        ? basePrompt
        : `${basePrompt}\n\n(iteration ${i}/${maxIter} — continue toward <promise>${untilTag}</promise>)`;
    // fresh_context → distinct thread per iteration; otherwise reuse the loop's thread
    const thread_id = fresh ? `${ctx.node.id}:iter-${i}` : threadBase;

    let outcome: Outcome;
    try {
      const budgetLimits = ctx.ledger ? buildBudgetLimits(ctx.graph, ctx.node) : undefined;
      const budgetSnapshot = ctx.ledger && budgetLimits ? ctx.ledger.query(ctx.node.id, budgetLimits) : undefined;
      const budgetStopped = ctx.budgetStoppedRef?.stopped ?? false;
      outcome = await ctx.backend.run({
        node: ctx.node,
        prompt: iterPrompt,
        context: ctx.context,
        thread_id,
        fidelity,
        signal: ctx.signal,
        run_id: ctx.run_id,
        workflow_sha: ctx.workflow_sha,
        emit,
        emitAt,
        iteration: { n: i, max: maxIter },
        ...(budgetSnapshot !== undefined ? { budget: budgetSnapshot } : {}),
        ...(budgetStopped ? { budget_stopped: true } : {}),
      });
    } catch (err) {
      return fail(`loop iteration ${i} crashed: ${err instanceof Error ? err.message : String(err)}`);
    }

    lastOutcome = outcome;
    Object.assign(accumulatedUpdates, outcome.context_updates);

    if (outcome.status === "fail") {
      // Failing a single iteration doesn't abort the loop — give the next one a chance.
      continue;
    }

    const tag = new RegExp(`<promise>\\s*${escapeRegex(untilTag)}\\s*</promise>`, "i");
    if (tag.test(outcome.notes)) {
      return {
        ...outcome,
        status: "success",
        notes: outcome.notes.replace(PROMISE_TAG_RE, "").trim(),
        context_updates: accumulatedUpdates,
      };
    }
  }

  return fail(`loop "${ctx.node.id}" did not emit <promise>${untilTag}</promise> within ${maxIter} iterations`, {
    notes: lastOutcome.notes,
    context_updates: accumulatedUpdates,
  });
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip accelerator markers from an edge label: "[Y] Yes" / "Y) Yes" / "Y - Yes". */
function extractAccelerator(label: string): { key: string; label: string } | undefined {
  const trimmed = label.trim();
  const brackets = /^\[([A-Za-z0-9])\]\s*(.*)$/.exec(trimmed);
  if (brackets) return { key: brackets[1]!.toUpperCase(), label: brackets[2]! };
  const paren = /^([A-Za-z0-9])\)\s*(.*)$/.exec(trimmed);
  if (paren) return { key: paren[1]!.toUpperCase(), label: paren[2]! };
  const dash = /^([A-Za-z0-9])\s*-\s*(.*)$/.exec(trimmed);
  if (dash) return { key: dash[1]!.toUpperCase(), label: dash[2]! };
  return undefined;
}

/** Wait for a human via the Interviewer. Choices derive from outgoing edge labels. */
const waitHumanHandler: Handler = async (ctx) => {
  const outgoing = ctx.graph.edges.filter((e) => e.from === ctx.node.id);
  const options = outgoing
    .map((e, i) => {
      const raw = (e.attrs.label ?? "").trim();
      const accel = extractAccelerator(raw);
      if (accel) return { key: accel.key, label: accel.label || raw };
      const fallback = raw || e.to;
      return { key: String(i + 1), label: fallback };
    })
    .filter((o) => o.label.length > 0);

  const prompt = substitute(ctx.node.attrs.prompt ?? "(human gate — no prompt set)", {
    context: ctx.context,
    args: ctx.args,
    nodeOutputs: ctx.node_outputs,
  });
  const idleTimeoutMs = typeof ctx.node.attrs.idle_timeout === "number" ? ctx.node.attrs.idle_timeout : undefined;
  const emit = buildEmit(ctx);

  const question: Question = {
    text: prompt,
    type: options.length > 0 ? "MULTIPLE_CHOICE" : "CONFIRMATION",
    stage: ctx.node.id,
    metadata: {},
    ...(options.length > 0 ? { options } : {}),
    ...(idleTimeoutMs !== undefined ? { timeout_seconds: idleTimeoutMs / 1000 } : {}),
  };

  await emit("interview.started", {
    question_type: question.type,
    option_count: options.length,
  });

  try {
    const answer = await ctx.interviewer.ask(question);
    await emit("interview.completed", { value: String(answer.value) });

    const v = String(answer.value).toUpperCase();
    if (v === "TIMEOUT") {
      await emit("interview.timeout", {});
      return fail("human gate timed out");
    }
    if (v === "NO") return fail("human declined");

    const matchedLabel = answer.selected_option?.label ?? (typeof answer.value === "string" ? answer.value : "");
    return ok({
      notes: `human approved: ${matchedLabel}`,
      preferred_label: matchedLabel,
    });
  } catch (err) {
    return fail(`wait.human failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

// ---------------------------------------------------------------------------
// Parallel + fan_in

/** Aggregates branch outcomes already merged into context by the parallel handler.
 * Succeeds if ≥1 branch succeeded; partial if some failed; fail if all failed. */
const fanInHandler: Handler = async (ctx) => {
  const total = typeof ctx.context["parallel.count"] === "number" ? ctx.context["parallel.count"] : 0;
  const successes = typeof ctx.context["parallel.successes"] === "number" ? ctx.context["parallel.successes"] : 0;

  if (total === 0) return ok({ notes: "fan_in: no branches" });
  if (successes === 0) {
    return fail(`fan_in: all ${total} branches failed`, { notes: `0/${total} branches succeeded` });
  }
  if (successes < total) {
    return {
      ...ok({ notes: `fan_in: ${successes}/${total} branches succeeded` }),
      status: "partial_success",
    };
  }
  return ok({ notes: `fan_in: ${successes}/${total} branches succeeded` });
};

const parallelHandler: Handler = async (ctx) => {
  const outgoing = ctx.graph.edges.filter((e) => e.from === ctx.node.id);
  if (outgoing.length === 0) return fail(`parallel node "${ctx.node.id}" has no outgoing branches`);

  const fanInId =
    ctx.node.attrs.fan_in ??
    inferFanIn(
      ctx.graph,
      outgoing.map((e) => e.to),
    );
  if (!fanInId) {
    return fail(`parallel "${ctx.node.id}": fan_in not specified and cannot be inferred`);
  }
  const fanInNode = ctx.graph.nodes[fanInId];
  if (!fanInNode) return fail(`parallel "${ctx.node.id}": fan_in "${fanInId}" not found`);
  if (fanInNode.shape !== "tripleoctagon") {
    return fail(`parallel "${ctx.node.id}": fan_in "${fanInId}" must be tripleoctagon (got ${fanInNode.shape})`);
  }

  const policy = ctx.node.attrs.join_policy ?? "wait_all";

  const branchPromises = outgoing.map(async (edge, idx) => {
    const start = ctx.graph.nodes[edge.to];
    if (!start) {
      return { idx, outcome: fail(`branch target "${edge.to}" not found`), nodeId: edge.to, updates: {} };
    }
    const branchCtx: ContextMap = { ...ctx.context };
    branchCtx["parallel.branch_idx"] = idx;
    branchCtx["parallel.branch_from"] = edge.to;

    const result = await runLoop({
      graph: ctx.graph,
      start_at: start,
      stop_at: fanInId,
      context: branchCtx,
      handlers: HANDLERS,
      sink: ctx.sink,
      interviewer: ctx.interviewer,
      backend: ctx.backend,
      signal: ctx.signal,
      now: ctx.now,
      random: ctx.random,
      run_id: ctx.run_id,
      workflow_sha: ctx.workflow_sha,
      max_steps: 500,
      node_outputs: ctx.node_outputs,
      completed_nodes: [],
      node_outcomes: {},
      retry_counts: {},
      args: ctx.args,
    });
    // Diff branch context against parent to capture cross-node updates the
    // branch made. Engine-managed and per-branch keys are filtered out.
    const updates: Record<string, ContextValue> = {};
    for (const [k, v] of Object.entries(branchCtx)) {
      if (isEngineKey(k) || k.startsWith("parallel.branch_")) continue;
      if (ctx.context[k] !== v) updates[k] = v as ContextValue;
    }
    return { idx, outcome: result.finalOutcome, nodeId: edge.to, updates };
  });

  let branchResults: Array<{ idx: number; outcome: Outcome; nodeId: string; updates: Record<string, ContextValue> }>;
  if (policy === "first_success") {
    branchResults = await raceFirstSuccess(branchPromises);
  } else {
    branchResults = await Promise.all(branchPromises);
  }

  const merged: Record<string, ContextValue> = {};
  for (const br of branchResults) {
    Object.assign(merged, br.updates);
    Object.assign(merged, br.outcome.context_updates);
  }
  const succeeded = branchResults.filter(
    (r) => r.outcome.status === "success" || r.outcome.status === "partial_success",
  );
  merged["parallel.count"] = branchResults.length;
  merged["parallel.successes"] = succeeded.length;
  merged["parallel.branch_results"] = branchResults.map((r) => ({
    id: r.nodeId,
    status: r.outcome.status,
    notes: r.outcome.notes,
  })) as ContextValue;

  const fanInCtx: HandlerContext = {
    ...ctx,
    node: fanInNode,
    context: { ...ctx.context, ...merged },
  };
  const emitFanIn = buildEmit(fanInCtx);
  await emitFanIn(
    "node.started",
    buildNodeStartedData(ctx.graph, fanInNode, fanInCtx.context, ctx.node_outputs) as Record<string, unknown>,
  );
  const startAt = Date.now();
  const fanInOutcome = await fanInHandler(fanInCtx);
  const duration_ms = Date.now() - startAt;
  await emitFanIn("node.completed", { outcome: fanInOutcome, duration_ms, retry_count: 0 });

  const selection = selectEdge({
    graph: ctx.graph,
    source: fanInNode,
    outcome: fanInOutcome,
    context: fanInCtx.context,
  });

  const out: Outcome = {
    ...fanInOutcome,
    context_updates: { ...merged, ...fanInOutcome.context_updates },
  };
  if (selection) out.next_node_override = selection.edge.to;
  return out;
};

/** Race branches; resolve as soon as one succeeds (cancel others implicitly
 * via parent AbortSignal eventually). If all finish without success, returns
 * all results so the fan_in can report failure. */
async function raceFirstSuccess<T extends { outcome: Outcome }>(promises: Promise<T>[]): Promise<T[]> {
  const results: T[] = [];
  let settled = 0;
  return await new Promise<T[]>((resolve) => {
    if (promises.length === 0) return resolve([]);
    for (const p of promises) {
      p.then((r) => {
        results.push(r);
        settled++;
        if (r.outcome.status === "success" || r.outcome.status === "partial_success") {
          resolve([...results]);
        } else if (settled === promises.length) {
          resolve(results);
        }
      }).catch(() => {
        settled++;
        if (settled === promises.length) resolve(results);
      });
    }
  });
}

/** Infer fan_in: the nearest shared tripleoctagon descendant of all branch starts. */
function inferFanIn(graph: Graph, branchStarts: string[]): string | undefined {
  if (branchStarts.length === 0) return undefined;
  const sets = branchStarts.map((id) => descendantsIncluding(graph, id));
  const common = intersectAll(sets);
  const candidates = [...common].filter((id) => graph.nodes[id]?.shape === "tripleoctagon");
  if (candidates.length === 0) return undefined;
  // Pick the "nearest" — lexical tiebreak on id (deterministic).
  candidates.sort();
  return candidates[0];
}

const ENGINE_KEY_SET = new Set<string>([
  ENGINE_CONTEXT_KEYS.outcome,
  ENGINE_CONTEXT_KEYS.preferred_label,
  ENGINE_CONTEXT_KEYS.current_node,
  ENGINE_CONTEXT_KEYS.last_stage,
  ENGINE_CONTEXT_KEYS.last_response,
]);

function isEngineKey(key: string): boolean {
  return ENGINE_KEY_SET.has(key) || key.startsWith("internal.retry_count.") || key.startsWith("graph.");
}

function intersectAll(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) return new Set();
  const smallest = sets.reduce((a, b) => (a.size <= b.size ? a : b));
  const out = new Set<string>();
  outer: for (const x of smallest) {
    for (const s of sets) {
      if (!s.has(x)) continue outer;
    }
    out.add(x);
  }
  return out;
}

function descendantsIncluding(graph: Graph, start: string): Set<string> {
  const visited = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const e of graph.edges) if (e.from === id) stack.push(e.to);
  }
  return visited;
}

export const HANDLERS: Record<string, Handler> = {
  start: startHandler,
  exit: exitHandler,
  conditional: conditionalHandler,
  codergen: codergenHandler,
  loop: loopHandler,
  "wait.human": waitHumanHandler,
  parallel: parallelHandler,
  "parallel.fan_in": fanInHandler,
};

// ---------------------------------------------------------------------------
// Loop core — shared by execute() and branches inside parallel handlers.

interface LoopArgs {
  graph: Graph;
  start_at: Node;
  /** If set, stop when reaching this node id (exclusive). Used by parallel branches. */
  stop_at?: string;
  context: ContextMap;
  handlers: Record<string, Handler>;
  sink: EventSink;
  interviewer: Interviewer;
  backend: CodergenBackend;
  signal: AbortSignal;
  now: () => string;
  random: () => number;
  run_id: string;
  workflow_sha: string;
  max_steps: number;
  node_outputs: Map<string, NodeOutput>;
  completed_nodes: string[];
  node_outcomes: Record<string, Outcome>;
  retry_counts: Record<string, number>;
  args: SubstitutionArgs;
  ledger?: BudgetLedger;
  budgetStoppedRef?: { stopped: boolean };
  resumeDegradedNodes?: Set<string>;
  /** Wave 6: called after each node's outcome is folded into state so
   * the executor can snapshot to a CheckpointStore without leaking
   * the store port into the loop core. */
  onNodeCompleted?: (node: Node) => Promise<void>;
  /** Called after checkpoint save, before advancing to the next node.
   * Returns a promise — the loop awaits it before stepping. Used to
   * implement soft-pause: the executor's control loop sets
   * `paused=true` on `control.pause` and the promise only resolves
   * when a matching `control.resume` arrives. Safe terminal nodes
   * return earlier so this never blocks at pipeline end. */
  onBoundary?: (args: { completedNodeId: string; nextNodeId: string }) => Promise<void>;
}

type StopReason = "terminal" | "stop_at" | "no_edge" | "max_steps" | "aborted" | "error";

interface LoopResult {
  finalOutcome: Outcome;
  stopped: StopReason;
  lastNode: Node | null;
}

async function runLoop(args: LoopArgs): Promise<LoopResult> {
  const { graph, handlers, sink, signal, now, workflow_sha, run_id } = args;
  let current: Node | null = args.start_at;
  let steps = 0;
  let lastOutcome: Outcome = ok({ notes: "pipeline completed" });

  const emit = async (type: EventType, node: Node | undefined, data: Record<string, unknown>): Promise<void> => {
    const ev: Event = {
      run_id,
      type,
      timestamp: now(),
      workflow_sha,
      schema_version: EVENT_SCHEMA_VERSION,
      data,
      ...(node ? { node_id: node.id } : {}),
    };
    await sink.append(ev);
  };

  while (current) {
    if (args.stop_at !== undefined && current.id === args.stop_at) {
      return { finalOutcome: lastOutcome, stopped: "stop_at", lastNode: current };
    }
    if (steps++ >= args.max_steps) {
      return {
        finalOutcome: { ...lastOutcome, status: "fail", failure_reason: `exceeded max_steps=${args.max_steps}` },
        stopped: "max_steps",
        lastNode: current,
      };
    }
    if (signal.aborted) {
      return {
        finalOutcome: { ...lastOutcome, status: "fail", failure_reason: "aborted" },
        stopped: "aborted",
        lastNode: current,
      };
    }

    const node: Node = current;
    const handler = handlers[handlerOf(node)];
    if (!handler) {
      await emit("node.failed", node, { reason: `no handler for "${node.shape}"` });
      return {
        finalOutcome: { ...lastOutcome, status: "fail", failure_reason: `no handler for shape "${node.shape}"` },
        stopped: "error",
        lastNode: node,
      };
    }

    await emit(
      "node.started",
      node,
      buildNodeStartedData(graph, node, args.context, args.node_outputs) as Record<string, unknown>,
    );
    const startAt = Date.now();

    const outcome = await runWithRetry({
      handler,
      node,
      graph,
      context: args.context,
      run_id,
      workflow_sha,
      sink,
      interviewer: args.interviewer,
      backend: args.backend,
      signal,
      now,
      random: args.random,
      node_outputs: args.node_outputs,
      retry_counts: args.retry_counts,
      args: args.args,
      ...(args.ledger !== undefined ? { ledger: args.ledger } : {}),
      ...(args.budgetStoppedRef !== undefined ? { budgetStoppedRef: args.budgetStoppedRef } : {}),
      ...(args.resumeDegradedNodes !== undefined ? { resumeDegradedNodes: args.resumeDegradedNodes } : {}),
      // ledger + budgetStoppedRef + resumeDegradedNodes flow through
      // HandlerContext since RetryInput extends it — spreads above
      // forward the trio into the retry wrapper's inherited slots.
    });
    lastOutcome = outcome;

    const duration_ms = Date.now() - startAt;

    for (const [k, v] of Object.entries(outcome.context_updates)) args.context[k] = v;
    args.context[ENGINE_CONTEXT_KEYS.outcome] = outcome.status;
    if (outcome.preferred_label) args.context[ENGINE_CONTEXT_KEYS.preferred_label] = outcome.preferred_label;
    args.context[ENGINE_CONTEXT_KEYS.current_node] = node.id;
    args.context[ENGINE_CONTEXT_KEYS.last_stage] = node.id;

    if (outcome.status === "success" || outcome.status === "partial_success") {
      args.node_outputs.set(node.id, { success: true, output: outcome.notes, timestamp: Date.now() });
    }

    args.completed_nodes.push(node.id);
    args.node_outcomes[node.id] = outcome;

    await emit("node.completed", node, {
      outcome,
      duration_ms,
      retry_count: args.retry_counts[node.id] ?? 0,
    });

    // Terminal node reached: stop; caller decides next step (goal gates etc.)
    if (isTerminal(node) && node.shape === "Msquare") {
      return { finalOutcome: outcome, stopped: "terminal", lastNode: node };
    }

    // Explicit next-node override (used by parallel handler to skip past fan_in)
    if (outcome.next_node_override) {
      const next = graph.nodes[outcome.next_node_override];
      if (!next) {
        return {
          finalOutcome: { ...outcome, status: "fail", failure_reason: `missing node "${outcome.next_node_override}"` },
          stopped: "error",
          lastNode: node,
        };
      }
      // Wave 6: persist the snapshot with `current_node = <next>` so a
      // resume picks up at the node that hadn't started yet (not the
      // one that just completed, which would otherwise re-run).
      if (args.onNodeCompleted) await args.onNodeCompleted(next);
      if (args.onBoundary) await args.onBoundary({ completedNodeId: node.id, nextNodeId: next.id });
      current = next;
      continue;
    }

    const selection: EdgeSelection | undefined = selectEdge({
      graph,
      source: node,
      outcome,
      context: args.context,
    });
    if (!selection) {
      const final = outcome.status === "fail" ? outcome : ok({ notes: "pipeline completed (no outgoing edge)" });
      return { finalOutcome: final, stopped: "no_edge", lastNode: node };
    }

    await emit("edge.selected", node, {
      from: selection.edge.from,
      to: selection.edge.to,
      rule: selection.rule,
      ...(selection.matched !== undefined ? { matched: selection.matched } : {}),
    });

    const next = graph.nodes[selection.edge.to];
    if (!next) {
      return {
        finalOutcome: { ...lastOutcome, status: "fail", failure_reason: `missing node "${selection.edge.to}"` },
        stopped: "error",
        lastNode: node,
      };
    }
    // Wave 6 checkpoint hook fires here with the NEXT node so
    // resume starts at what hadn't begun yet.
    if (args.onNodeCompleted) await args.onNodeCompleted(next);
    if (args.onBoundary) await args.onBoundary({ completedNodeId: node.id, nextNodeId: next.id });
    current = next;
  }

  return { finalOutcome: lastOutcome, stopped: "no_edge", lastNode: null };
}

// ---------------------------------------------------------------------------
// Execute

export interface ExecuteOptions {
  graph: Graph;
  /** Optional pre-computed SHA of the workflow source. Stored on every event. */
  workflow_sha?: string;
  /**
   * Path of the workflow source file (as given, usually relative). Emitted
   * on `pipeline.started` so downstream tooling can display a human-readable
   * name without keeping the SHA→path mapping out-of-band.
   */
  workflow_path?: string;
  /**
   * Raw DOT text of the workflow source. Emitted on `pipeline.started` so
   * the server can re-render the graph to SVG without needing filesystem
   * access to `workflow_path`. Omitted from the event when not provided.
   */
  workflow_source?: string;
  /** Opaque id for this run. If omitted, a deterministic one is generated. */
  run_id?: string;
  /** Starting context values. `graph.*` keys are mirrored automatically. */
  initial_context?: Record<string, unknown>;
  /**
   * Positional arguments for prompt substitution. Reach any node that uses
   * `$ARGUMENTS` / `$1..$9` / `$ARTIFACTS_DIR` / etc. This is distinct from
   * `initial_context`: context keys are read via `${context.<key>}`, while
   * positional args are read via `$ARGUMENTS`. The CLI's `--input` /
   * `--input-file` flags flow here.
   */
  args?: SubstitutionArgs;
  sink?: EventSink;
  interviewer?: Interviewer;
  backend?: CodergenBackend;
  signal?: AbortSignal;
  /** Inject a clock for deterministic tests. */
  now?: () => string;
  /** Inject a seeded RNG for deterministic tests. */
  random?: () => number;
  /** Override the handler registry (tests can stub handlers). */
  handlers?: Record<string, Handler>;
  /** Hard cap to prevent runaway loops. Default 500. */
  max_steps?: number;
  /** Optional summariser — powers (a) the async pipeline-title generation
   * and (b) `fidelity=summary:medium/high` inside backends that consult
   * it. CLI wires a `PiSummariserBackend`; tests can pass a stub or
   * omit it to keep runs pure. */
  summariser?: SummariserBackend;
  /** Auto-title policy. `"on"` (default) kicks off a background summariser
   * call over `$ARGUMENTS` at pipeline start and emits
   * `pipeline.title_generated` when it resolves. `"off"` skips the call
   * entirely. Graph attr `auto_title` overrides this per-workflow. */
  auto_title?: "on" | "off";
  /** Wave 6: checkpoint persistence. When set, the executor calls
   * `save()` after every node's retry/loop cycle so a crash can be
   * recovered by running with `resume: true`. Each saved checkpoint
   * supersedes the prior one — the file is a snapshot, not a log. */
  checkpointStore?: CheckpointStore;
  /** Wave 6: resume from the most recent checkpoint for `run_id`.
   * When `true` and the store has one, the executor hydrates
   * `context` / `completed_nodes` / `node_outcomes` / `retry_counts`,
   * restores `pi_sessions` into the backend's transcript store via
   * `hydrateSessions()`, and applies `degradeOnResume` to the first
   * codergen call on `current_node` (SPEC §3.6). Silently no-ops
   * when no checkpoint exists so the same CLI flag works for fresh
   * runs. */
  resume?: boolean;
  /** Control channel hookup. When present, the executor tails the
   * JSONL file at `path`, mirrors each request into the event stream
   * as `control.requested`, dispatches it to the right boundary
   * (steer → backend.steer; pause/resume/cancel later), and emits a
   * paired `control.applied` or `control.rejected`. The `tail`
   * function matches `@swarm/events`'s `tailControlRequests`
   * signature — injected to keep @swarm/core free of filesystem
   * I/O (SPEC §2). See docs/SPEC.md §3.7. */
  controlChannel?: {
    /** JSONL file path containing `ControlRequest` lines. */
    path: string;
    /** Injected tailer. Must yield one `ControlRequest` per valid line,
     * first existing content then appends, until the signal aborts. */
    tail: (path: string, opts: { signal: AbortSignal; includeExisting?: boolean }) => AsyncIterable<ControlRequest>;
  };
}

export async function execute(opts: ExecuteOptions): Promise<ExecutionResult> {
  const graph = opts.graph;
  applyStylesheet(graph);
  const rawSink: EventSink = opts.sink ?? new InMemorySink();
  const interviewer: Interviewer = opts.interviewer ?? new AutoApproveInterviewer();
  const backend: CodergenBackend = opts.backend ?? new MockCodergenBackend();
  // `cancelController` backs `control.cancel`. The effective signal fires
  // when either the caller's signal aborts OR a cancel request lands on
  // the control channel, so every signal-aware downstream (runLoop,
  // handlers, tool calls) trips without special casing.
  const cancelController = new AbortController();
  const signal =
    opts.signal !== undefined ? AbortSignal.any([opts.signal, cancelController.signal]) : cancelController.signal;
  const now = opts.now ?? (() => new Date().toISOString());
  const random = opts.random ?? Math.random;
  const handlers = opts.handlers ?? HANDLERS;
  const max_steps = opts.max_steps ?? 500;
  const workflow_sha = opts.workflow_sha ?? "";
  const run_id = opts.run_id ?? `run-${now()}`;

  const context: ContextMap = { ...(opts.initial_context as ContextMap) };
  for (const [k, v] of Object.entries(graph.attrs)) {
    context[`graph.${k}`] = v as ContextValue;
  }
  context[ENGINE_CONTEXT_KEYS.run_id] = run_id;

  // Wave 4: BudgetLedger + sink-wrapper that auto-records every
  // cost.recorded event. Only stood up when at least one budget knob
  // is configured — otherwise all runs would pay the book-keeping cost
  // for nothing. Policy defaults to "stop" when any ceiling exists.
  const budgetConfigured = hasAnyBudget(graph);
  const ledger: BudgetLedger | undefined = budgetConfigured ? new BudgetLedger() : undefined;
  const budgetStoppedRef: { stopped: boolean } | undefined = ledger ? { stopped: false } : undefined;
  const policy: "warn" | "stop" =
    (graph.attrs.budget_policy as "warn" | "stop" | undefined) ?? (budgetConfigured ? "stop" : "warn");
  const sink: EventSink = ledger
    ? wrapSinkWithLedger({
        inner: rawSink,
        ledger,
        graph,
        run_id,
        workflow_sha,
        now,
        policy,
        stoppedRef: budgetStoppedRef!,
      })
    : rawSink;

  const node_outputs = new Map<string, NodeOutput>();
  const completed_nodes: string[] = [];
  const node_outcomes: Record<string, Outcome> = {};
  const retry_counts: Record<string, number> = {};
  const substitutionArgs: SubstitutionArgs = opts.args ?? {};

  // Wave 6: optional resume path. Load the most recent checkpoint for
  // this run_id and hydrate executor state before the first node runs.
  // Silently no-ops when no checkpoint exists so the same CLI flag is
  // safe on fresh runs. The `resumeDegradedNodes` set tells the
  // codergen handler to apply `degradeOnResume` to the first call on
  // the resumed node (SPEC §3.6).
  const resumeDegradedNodes = new Set<string>();
  let resumeStartNodeId: string | undefined;
  // Control-channel state. `lastAppliedControlId` survives restarts via
  // the checkpoint so re-tailing a populated control.jsonl on resume
  // doesn't re-apply already-handled requests. The `paused` flag is
  // reserved for pause/resume support (P4).
  let lastAppliedControlId: string | undefined;
  let paused = false;
  if (opts.resume === true && opts.checkpointStore) {
    const loaded = await opts.checkpointStore.load(run_id);
    if (loaded) {
      Object.assign(context, loaded.context);
      for (const id of loaded.completed_nodes) completed_nodes.push(id);
      Object.assign(node_outcomes, loaded.node_outcomes);
      Object.assign(retry_counts, loaded.retry_counts);
      if (backend.hydrateSessions) backend.hydrateSessions(loaded.pi_sessions);
      resumeDegradedNodes.add(loaded.current_node);
      resumeStartNodeId = loaded.current_node;
      if (loaded.last_applied_control_id !== undefined) lastAppliedControlId = loaded.last_applied_control_id;
      if (loaded.paused === true) paused = true;
    }
  }

  const emit = async (type: EventType, node: Node | undefined, data: Record<string, unknown>): Promise<void> => {
    const ev: Event = {
      run_id,
      type,
      timestamp: now(),
      workflow_sha,
      schema_version: EVENT_SCHEMA_VERSION,
      data,
      ...(node ? { node_id: node.id } : {}),
    };
    await sink.append(ev);
  };

  const startedData: Record<string, unknown> = { graph_id: graph.id };
  if (opts.workflow_path) startedData["workflow_path"] = opts.workflow_path;
  if (opts.workflow_source) startedData["workflow_source"] = opts.workflow_source;
  // Carry the user's $ARGUMENTS on pipeline.started so UI / backfill tooling
  // can compute a title later without replaying the whole stream.
  if (typeof substitutionArgs.$ARGUMENTS === "string" && substitutionArgs.$ARGUMENTS.length > 0) {
    startedData["input"] = substitutionArgs.$ARGUMENTS;
  }
  await emit("pipeline.started", undefined, startedData);

  // Fire-and-forget pipeline title generation. `pipeline.started` has already
  // gone out so the UI isn't blocked; when the summariser returns we emit
  // `pipeline.title_generated` and mirror the title into `context["graph.title"]`
  // so downstream nodes can substitute `${context.graph.title}` if they want.
  // Failures are silent by design — a missing summariser or flaky key must
  // not crash the pipeline; the run just goes untitled.
  const titlePromise = maybeStartPipelineTitle({
    summariser: opts.summariser,
    args: substitutionArgs,
    graph,
    run_id,
    workflow_sha,
    now,
    sink,
    context,
    auto_title: opts.auto_title,
    signal,
  });

  // ── Control channel ────────────────────────────────────────────────
  // Spin up a concurrent tail of control.jsonl. Each request mirrors into
  // events.jsonl as `control.requested`, dispatches to the command-specific
  // boundary, and acknowledges with `control.applied` or `control.rejected`.
  // The checkpoint writer reads `lastAppliedControlId` so a restart skips
  // requests already reflected in the event stream.
  //
  // Pause/resume are two-phase:
  //   - On `control.pause.requested`, flip the `paused` flag and record the
  //     pending request id. `control.applied` is emitted by runLoop's
  //     `onBoundary` hook when the current node finishes — the gap between
  //     requested and applied is the implicit "pending" state. Soft pause
  //     only: a running node runs to completion.
  //   - On `control.resume.requested`, clear the flag, wake the boundary
  //     waiter, and emit `control.applied` for the resume request.
  //
  // Cancel lands in P5.
  const controlAbort = new AbortController();
  const pause = createPauseState();
  /** Captured when `control.cancel` fires, so the pipeline-terminal step
   * below emits `pipeline.canceled` (with the originating request id)
   * instead of `pipeline.failed`. */
  let cancelState: { id: string; reason?: string } | undefined;
  const controlLoopDone: Promise<void> = opts.controlChannel
    ? runControlLoop({
        tailIter: opts.controlChannel.tail(opts.controlChannel.path, { signal: controlAbort.signal }),
        skipUpToId: lastAppliedControlId,
        onApplied: (id) => {
          lastAppliedControlId = id;
        },
        backend,
        emit,
        pause,
        getPaused: () => paused,
        setPaused: (v) => {
          paused = v;
        },
        isCancelled: () => cancelState !== undefined,
        requestCancel: (id, reason) => {
          cancelState = { id, ...(reason !== undefined ? { reason } : {}) };
          // Trip the abort so any in-flight handler / tool call unwinds.
          cancelController.abort();
          // If the run is currently paused at a boundary, wake it so
          // execute() can unwind and emit pipeline.canceled. The paused
          // flag stays true on the outer var until exit so checkpoints
          // reflect the final state if a save runs; the resume promise
          // just needs to resolve.
          pause.resolveResume();
        },
      })
    : Promise.resolve();

  // On resume, jump straight to the checkpointed current_node when it
  // still exists in the workflow. If the workflow has changed and the
  // id is stale, fall through to `findStart` — that's safer than
  // aborting the resume outright.
  let current: Node =
    resumeStartNodeId !== undefined && graph.nodes[resumeStartNodeId]
      ? graph.nodes[resumeStartNodeId]!
      : findStart(graph);
  let finalOutcome: Outcome = ok({ notes: "pipeline completed" });
  let goalGateRetries = 0;
  const maxGoalGateRetries =
    typeof graph.attrs.max_goal_gate_retries === "number" ? graph.attrs.max_goal_gate_retries : 3;
  // Two-phase goal-gate retry: primary `retry_target` (or `fallback_retry_target`
  // when no primary is set), then switch to a distinct `fallback_retry_target`
  // with a fresh budget if the primary exhausts. `phaseUsedFallback` flips once
  // the switch happens and stays flipped for the rest of the pipeline.
  let phaseUsedFallback = false;
  const primaryRetryTarget = graph.attrs.retry_target ?? graph.attrs.fallback_retry_target;
  const distinctFallbackRetryTarget =
    graph.attrs.retry_target &&
    graph.attrs.fallback_retry_target &&
    graph.attrs.retry_target !== graph.attrs.fallback_retry_target
      ? graph.attrs.fallback_retry_target
      : undefined;

  while (true) {
    const result = await runLoop({
      graph,
      start_at: current,
      context,
      handlers,
      sink,
      interviewer,
      backend,
      signal,
      now,
      random,
      run_id,
      workflow_sha,
      max_steps,
      node_outputs,
      completed_nodes,
      node_outcomes,
      retry_counts,
      args: substitutionArgs,
      ...(ledger !== undefined ? { ledger } : {}),
      ...(budgetStoppedRef !== undefined ? { budgetStoppedRef } : {}),
      ...(resumeDegradedNodes.size > 0 || opts.checkpointStore ? { resumeDegradedNodes } : {}),
      ...(opts.checkpointStore
        ? {
            onNodeCompleted: async (node: Node) => {
              const snapshot: Checkpoint = {
                version: CHECKPOINT_SCHEMA_VERSION,
                run_id,
                workflow_sha,
                current_node: node.id,
                completed_nodes: [...completed_nodes],
                node_outcomes: { ...node_outcomes },
                context: { ...context },
                retry_counts: { ...retry_counts },
                pi_sessions: backend.serialiseSessions ? backend.serialiseSessions() : {},
                saved_at: now(),
                ...(lastAppliedControlId !== undefined ? { last_applied_control_id: lastAppliedControlId } : {}),
                ...(paused ? { paused: true } : {}),
              };
              await opts.checkpointStore!.save(run_id, snapshot);
            },
          }
        : {}),
      onBoundary: async ({ completedNodeId }) => {
        // Pause gate: if a pause has landed, emit `control.applied` for
        // it now (boundary reached) then block until `control.resume`
        // wakes the promise. On a fresh (unpaused) run this is a no-op.
        if (!paused) return;
        const pendingId = pause.pendingPauseRequestId;
        if (pendingId !== undefined) {
          await emit("control.applied", undefined, {
            id: pendingId,
            command: "pause",
            applied_at_node: completedNodeId,
          });
          lastAppliedControlId = pendingId;
          pause.pendingPauseRequestId = undefined;
        }
        await pause.awaitResume();
      },
    });

    // If we stopped at a terminal Msquare, check goal gates + maybe retry.
    if (result.stopped === "terminal" && result.lastNode?.shape === "Msquare") {
      // Honour `outcome.non_retryable`: a node emitted an intentional abort
      // (e.g. "task target is missing"), so the goal-gate retry machinery
      // should stay out of the way. Keep the original fail reason rather
      // than overwriting it with a "goal gate(s) unsatisfied" message.
      const aborted = Object.values(node_outcomes).find((o) => o.status === "fail" && o.non_retryable === true);
      if (aborted) {
        finalOutcome = aborted;
        break;
      }
      const unsat = unsatisfiedGoalGates(graph, node_outcomes);
      if (unsat.length > 0) {
        // Phase-aware retry. Primary phase spends up to maxGoalGateRetries on
        // `primaryRetryTarget`. When that's exhausted AND a distinct
        // `fallback_retry_target` exists, we reset the budget and switch to
        // the fallback for a fresh round. Both exhausted → pipeline fails.
        let jumpTarget: string | undefined;
        if (
          !phaseUsedFallback &&
          primaryRetryTarget &&
          graph.nodes[primaryRetryTarget] &&
          goalGateRetries < maxGoalGateRetries
        ) {
          jumpTarget = primaryRetryTarget;
        } else if (!phaseUsedFallback && distinctFallbackRetryTarget && graph.nodes[distinctFallbackRetryTarget]) {
          phaseUsedFallback = true;
          goalGateRetries = 0;
          jumpTarget = distinctFallbackRetryTarget;
        } else if (
          phaseUsedFallback &&
          distinctFallbackRetryTarget &&
          graph.nodes[distinctFallbackRetryTarget] &&
          goalGateRetries < maxGoalGateRetries
        ) {
          jumpTarget = distinctFallbackRetryTarget;
        }

        if (jumpTarget) {
          goalGateRetries++;
          current = graph.nodes[jumpTarget]!;
          continue;
        }

        const exhaustedTarget = phaseUsedFallback ? distinctFallbackRetryTarget : primaryRetryTarget;
        const exhausted = exhaustedTarget && goalGateRetries >= maxGoalGateRetries;
        finalOutcome = {
          ...result.finalOutcome,
          status: "fail",
          failure_reason: exhausted
            ? `goal gate(s) unsatisfied after ${maxGoalGateRetries} retries to "${exhaustedTarget}"${
                phaseUsedFallback && distinctFallbackRetryTarget
                  ? ` (fallback after primary "${primaryRetryTarget}" exhausted)`
                  : ""
              }: ${unsat.join(", ")}`
            : `goal gate(s) unsatisfied: ${unsat.join(", ")}`,
        };
        break;
      }
      finalOutcome = ok({ notes: "pipeline completed" });
      break;
    }

    finalOutcome = result.finalOutcome;
    break;
  }

  // Wait briefly for the title before closing the run, so the
  // `pipeline.title_generated` event lands in `events.jsonl` before
  // `pipeline.completed`. If the summariser is still outstanding (or it
  // was never kicked off) this resolves immediately.
  await titlePromise;

  // Tear down the control loop before emitting terminal events. The
  // AbortController wakes the tailer; `controlLoopDone` resolves once
  // its generator unwinds. Errors inside the loop are caught there and
  // logged via the sink — nothing propagates here.
  controlAbort.abort();
  await controlLoopDone;

  const goal_gates_satisfied = unsatisfiedGoalGates(graph, node_outcomes).length === 0;

  if (cancelState !== undefined) {
    // Cancel takes precedence: even if the run had already failed when
    // the request landed, the *reason it stopped* is the cancel. The
    // final outcome records the request id + reason so a consumer can
    // distinguish canceled from spontaneous failure without replaying
    // the full stream.
    finalOutcome = {
      ...finalOutcome,
      status: "fail",
      failure_reason: `canceled${cancelState.reason ? `: ${cancelState.reason}` : ""}`,
    };
    await emit("pipeline.canceled", undefined, {
      cause: "control.cancel",
      request_id: cancelState.id,
      ...(cancelState.reason !== undefined ? { reason: cancelState.reason } : {}),
    });
  } else if (finalOutcome.status === "fail") {
    await emit("pipeline.failed", undefined, { reason: finalOutcome.failure_reason });
  } else {
    await emit("pipeline.completed", undefined, { outcome: finalOutcome });
  }

  if (sink.close) await sink.close();

  return {
    run_id,
    workflow_sha,
    outcome: finalOutcome,
    completed_nodes,
    node_outcomes,
    context,
    goal_gates_satisfied,
  };
}

// ---------------------------------------------------------------------------
// Internals

/**
 * Pause coordinator shared between the control loop and runLoop's
 * `onBoundary` hook. The control loop sets `pendingPauseRequestId`
 * and creates a fresh resume promise on `control.pause`; runLoop
 * awaits that promise at the next safe boundary. On `control.resume`
 * the loop calls `resolveResume()` which unblocks the waiter.
 */
interface PauseState {
  pendingPauseRequestId: string | undefined;
  /** Returns a promise that resolves when resume is called. Idempotent:
   * calling while already paused returns the same pending promise. */
  awaitResume(): Promise<void>;
  /** Begin a new pause cycle — creates a fresh unresolved promise. */
  beginPause(requestId: string): void;
  /** End the current pause cycle — resolves the outstanding promise.
   * Returns true if a pause was actually in effect, false if not. */
  resolveResume(): boolean;
}

function createPauseState(): PauseState {
  let resumeResolver: (() => void) | undefined;
  let resumePromise: Promise<void> | undefined;
  const state: PauseState = {
    pendingPauseRequestId: undefined,
    awaitResume: () => resumePromise ?? Promise.resolve(),
    beginPause(requestId: string) {
      // Idempotent: a second pause while already paused just updates
      // the pending request id (a rare race) and reuses the promise.
      state.pendingPauseRequestId = requestId;
      if (resumePromise) return;
      resumePromise = new Promise<void>((resolve) => {
        resumeResolver = resolve;
      });
    },
    resolveResume() {
      if (!resumePromise) return false;
      const resolver = resumeResolver;
      resumeResolver = undefined;
      resumePromise = undefined;
      resolver?.();
      return true;
    },
  };
  return state;
}

interface ControlLoopArgs {
  tailIter: AsyncIterable<ControlRequest>;
  /** Checkpoint-sourced id. Every request up to and including this id is
   * skipped so a resume doesn't double-apply. `undefined` on fresh runs. */
  skipUpToId: string | undefined;
  onApplied: (id: string) => void;
  backend: CodergenBackend;
  /** Run-scoped emit (no node_id attached). */
  emit: (type: EventType, node: Node | undefined, data: Record<string, unknown>) => Promise<void>;
  pause: PauseState;
  getPaused: () => boolean;
  setPaused: (v: boolean) => void;
  /** True once a cancel has been acknowledged — subsequent cancel
   * requests are rejected with `already_terminal` instead of double-firing. */
  isCancelled: () => boolean;
  /** Side channel: trip the execute-scope AbortController and wake any
   * paused boundary. Called once per accepted cancel request. */
  requestCancel: (id: string, reason: string | undefined) => void;
}

/**
 * Tail `control.jsonl` and dispatch each request. Emits `control.requested`
 * for every accepted request, then `control.applied` or `control.rejected`
 * as the per-command branch resolves.
 *
 * Pause is special-cased: this loop does NOT emit `control.applied(pause)`.
 * Instead it sets `paused=true` + `pendingPauseRequestId`; runLoop's
 * `onBoundary` hook emits `applied` when the current node finishes. The gap
 * between requested and applied is the pending state.
 *
 * Cancel lands in P5 and currently rejects with `not_implemented`.
 */
async function runControlLoop(args: ControlLoopArgs): Promise<void> {
  let resuming = args.skipUpToId !== undefined;
  try {
    for await (const request of args.tailIter) {
      // Skip every request up to and including the last-applied id from
      // the checkpoint. The file is strictly append-only so position-in-file
      // is equivalent to position-in-sequence; once we see the marker id we
      // apply everything that follows.
      if (resuming) {
        if (request.id === args.skipUpToId) resuming = false;
        continue;
      }

      const requestedData: Record<string, unknown> = { id: request.id, command: request.command };
      if (request.payload !== undefined) requestedData["payload"] = request.payload;
      await args.emit("control.requested", undefined, requestedData);

      switch (request.command) {
        case "steer": {
          const msg = request.payload?.message;
          if (typeof msg !== "string" || msg.length === 0) {
            await args.emit("control.rejected", undefined, {
              id: request.id,
              command: request.command,
              reason: "missing_message",
            });
            break;
          }
          if (args.backend.steer) {
            args.backend.steer(msg);
            await args.emit("control.applied", undefined, {
              id: request.id,
              command: request.command,
              note: "injected",
            });
            args.onApplied(request.id);
          } else {
            await args.emit("control.rejected", undefined, {
              id: request.id,
              command: request.command,
              reason: "backend_unsupported",
            });
            args.onApplied(request.id);
          }
          break;
        }
        case "pause": {
          if (args.getPaused()) {
            // Idempotent: already paused. Ack right away so the UI knows
            // the request landed, but don't gate twice at the next boundary.
            await args.emit("control.applied", undefined, {
              id: request.id,
              command: request.command,
              note: "already_paused",
            });
            args.onApplied(request.id);
            break;
          }
          args.setPaused(true);
          args.pause.beginPause(request.id);
          // Do NOT emit control.applied here. runLoop's onBoundary will
          // emit it when the current node completes; that's when pause
          // has actually taken effect.
          // Also do NOT call onApplied() yet — the checkpoint should see
          // last_applied_control_id advance only once the pause has landed.
          break;
        }
        case "resume": {
          if (!args.getPaused()) {
            await args.emit("control.rejected", undefined, {
              id: request.id,
              command: request.command,
              reason: "not_paused",
            });
            args.onApplied(request.id);
            break;
          }
          args.setPaused(false);
          args.pause.resolveResume();
          args.pause.pendingPauseRequestId = undefined;
          await args.emit("control.applied", undefined, {
            id: request.id,
            command: request.command,
          });
          args.onApplied(request.id);
          break;
        }
        case "cancel": {
          if (args.isCancelled()) {
            await args.emit("control.rejected", undefined, {
              id: request.id,
              command: request.command,
              reason: "already_terminal",
            });
            args.onApplied(request.id);
            break;
          }
          // Accept immediately. The side effect — tripping the run's
          // AbortController — happens synchronously via requestCancel so
          // downstream handlers / tool calls unwind on their next signal
          // check. `pipeline.canceled` is emitted by the terminal step in
          // execute() once runLoop returns (not here) so the cancel event
          // lands in strict causal order with everything that was still
          // in flight.
          const reason = request.payload?.reason;
          await args.emit("control.applied", undefined, {
            id: request.id,
            command: request.command,
            ...(reason !== undefined ? { note: reason } : {}),
          });
          args.requestCancel(request.id, reason);
          args.onApplied(request.id);
          break;
        }
        default: {
          await args.emit("control.rejected", undefined, {
            id: request.id,
            command: request.command,
            reason: "unknown_command",
          });
          args.onApplied(request.id);
        }
      }
    }
  } catch {
    // The tailer's own I/O errors are swallowed — a disappearing control
    // file must never crash the run. The executor continues without
    // control support for the remainder of this run.
  }
}

interface RetryInput extends HandlerContext {
  handler: Handler;
  retry_counts: Record<string, number>;
}

/** Exponential backoff parameters. Overridable via graph/node attrs later. */
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_FACTOR = 2;

async function runWithRetry(input: RetryInput): Promise<Outcome> {
  const { handler, node, graph, context, retry_counts, random, signal, sink, run_id, workflow_sha, now } = input;
  const maxRetries = resolveMaxRetries(graph, node);

  let attempt = 0;
  while (true) {
    let outcome: Outcome;
    try {
      outcome = await handler(input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outcome = fail(`handler threw: ${msg}`);
    }

    if (outcome.status === "success" || outcome.status === "partial_success" || outcome.status === "skipped") {
      return outcome;
    }

    if (attempt < maxRetries) {
      attempt++;
      retry_counts[node.id] = attempt;
      context[retryCountKey(node.id)] = attempt;

      // Exponential backoff with ±50% jitter. Gives the API room to recover from
      // 429s / transient network errors without hammering.
      const base = Math.min(BACKOFF_BASE_MS * BACKOFF_FACTOR ** (attempt - 1), BACKOFF_MAX_MS);
      const jitter = 1 + (random() - 0.5);
      const delayMs = Math.max(0, Math.round(base * jitter));

      await sink.append({
        run_id,
        type: "node.retrying",
        timestamp: now(),
        workflow_sha,
        schema_version: EVENT_SCHEMA_VERSION,
        node_id: node.id,
        data: {
          attempt,
          max_retries: maxRetries,
          delay_ms: delayMs,
          reason: outcome.failure_reason ?? "",
        },
      });

      if (delayMs > 0 && !signal.aborted) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      continue;
    }
    return outcome;
  }
}

function resolveMaxRetries(graph: Graph, node: Node): number {
  if (typeof node.attrs.max_retries === "number") return node.attrs.max_retries;
  if (typeof graph.attrs.default_max_retries === "number") return graph.attrs.default_max_retries;
  return 0;
}

/**
 * Build the `node.started` payload from everything we know *before* the
 * handler runs. Deliberately excludes the resolved prompt — that's a
 * per-LLM-call concern and lives on `llm.start` (resolved once per loop
 * iteration). Values that aren't set on the node are simply omitted so
 * test fixtures stay tight and JSONL replay stays cheap.
 */
function buildNodeStartedData(
  graph: Graph,
  node: Node,
  context: ContextMap,
  nodeOutputs: Map<string, NodeOutput>,
): NodeStartedData {
  const data: NodeStartedData = { node_type: handlerOf(node) };
  if (typeof node.attrs.prompt === "string" && node.attrs.prompt.length > 0) {
    data.prompt_template = node.attrs.prompt;
  }
  // Context keys only — values can be arbitrarily large and sensitive.
  // Engine-managed keys (`graph.*`, retry counters, last_stage, etc.)
  // are noisy; strip them so the UI shows user-facing scope only.
  const keys = Object.keys(context).filter((k) => !isEngineKey(k));
  if (keys.length > 0) data.context_keys = keys.sort();
  if (nodeOutputs.size > 0) data.node_outputs_in_scope = [...nodeOutputs.keys()].sort();
  if (typeof node.attrs.model === "string") data.model = node.attrs.model;
  if (typeof node.attrs.provider === "string") data.provider = node.attrs.provider;
  const threadId = resolveThreadId({ graph, edge: undefined, targetNode: node });
  if (threadId) data.thread_id = threadId;
  data.fidelity = resolveFidelity({ graph, edge: undefined, targetNode: node });
  const allow = node.attrs.allowed_tools;
  if (Array.isArray(allow) && allow.length > 0) data.allowed_tools = allow as string[];
  const deny = node.attrs.denied_tools;
  if (Array.isArray(deny) && deny.length > 0) data.denied_tools = deny as string[];
  const ctxFiles = node.attrs.context_files;
  if (Array.isArray(ctxFiles) && ctxFiles.length > 0) data.context_files = ctxFiles as string[];
  return data;
}

function findStart(graph: Graph): Node {
  const starts = Object.values(graph.nodes).filter((n) => n.shape === "Mdiamond");
  if (starts.length !== 1) {
    throw new Error(`graph must have exactly one start node (Mdiamond), found ${starts.length}`);
  }
  return starts[0]!;
}

function unsatisfiedGoalGates(graph: Graph, outcomes: Record<string, Outcome>): string[] {
  const gates: string[] = [];
  for (const n of Object.values(graph.nodes)) {
    if (n.attrs.goal_gate !== true) continue;
    const o = outcomes[n.id];
    if (!o || (o.status !== "success" && o.status !== "partial_success")) gates.push(n.id);
  }
  return gates;
}
