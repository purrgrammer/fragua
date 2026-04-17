// Main execution loop. Pure orchestration: parses, validates, dispatches to
// handlers, emits events, and returns an ExecutionResult. No I/O.
//
// See docs/SPEC.md §4.

import { type EdgeSelection, selectEdge } from "../engine/edge-selection.ts";
import { resolveFidelity, resolveThreadId } from "../engine/fidelity.ts";
import { applyStylesheet } from "../engine/stylesheet.ts";
import { type NodeOutput, type SubstitutionArgs, substitute } from "../engine/substitution.ts";
import { type EventSink, InMemorySink } from "../events/sink.ts";
import { AutoApproveInterviewer } from "../interviewer/index.ts";
import { type ContextMap, ENGINE_CONTEXT_KEYS, retryCountKey } from "../types/context.ts";
import type { Event, EventType, NodeStartedData } from "../types/events.ts";
import type { FidelityMode } from "../types/fidelity.ts";
import { type Graph, handlerOf, isTerminal, type Node } from "../types/graph.ts";
import type { Interviewer, Question } from "../types/interviewer.ts";
import { type ContextValue, fail, type Outcome, ok } from "../types/outcome.ts";

// ---------------------------------------------------------------------------
// Ports + types

export interface CodergenBackend {
  run(input: CodergenInput): Promise<Outcome>;
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
  const fidelity = resolveFidelity({ graph: ctx.graph, edge: undefined, targetNode: ctx.node });
  const thread_id = resolveThreadId({ graph: ctx.graph, edge: undefined, targetNode: ctx.node });

  const timeoutMs = parseTimeoutMs(ctx.node.attrs.timeout);
  const { signal, cancel } =
    timeoutMs !== undefined ? signalWithTimeout(ctx.signal, timeoutMs) : { signal: ctx.signal, cancel: () => {} };

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
}

export async function execute(opts: ExecuteOptions): Promise<ExecutionResult> {
  const graph = opts.graph;
  applyStylesheet(graph);
  const sink: EventSink = opts.sink ?? new InMemorySink();
  const interviewer: Interviewer = opts.interviewer ?? new AutoApproveInterviewer();
  const backend: CodergenBackend = opts.backend ?? new MockCodergenBackend();
  const signal = opts.signal ?? new AbortController().signal;
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

  const node_outputs = new Map<string, NodeOutput>();
  const completed_nodes: string[] = [];
  const node_outcomes: Record<string, Outcome> = {};
  const retry_counts: Record<string, number> = {};
  const substitutionArgs: SubstitutionArgs = opts.args ?? {};

  const emit = async (type: EventType, node: Node | undefined, data: Record<string, unknown>): Promise<void> => {
    const ev: Event = {
      run_id,
      type,
      timestamp: now(),
      workflow_sha,
      data,
      ...(node ? { node_id: node.id } : {}),
    };
    await sink.append(ev);
  };

  const startedData: Record<string, unknown> = { graph_id: graph.id };
  if (opts.workflow_path) startedData["workflow_path"] = opts.workflow_path;
  if (opts.workflow_source) startedData["workflow_source"] = opts.workflow_source;
  await emit("pipeline.started", undefined, startedData);

  let current: Node = findStart(graph);
  let finalOutcome: Outcome = ok({ notes: "pipeline completed" });
  let goalGateRetries = 0;
  const maxGoalGateRetries =
    typeof graph.attrs.max_goal_gate_retries === "number" ? graph.attrs.max_goal_gate_retries : 3;

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
        const retryTarget = graph.attrs.retry_target ?? graph.attrs.fallback_retry_target;
        if (retryTarget && graph.nodes[retryTarget] && goalGateRetries < maxGoalGateRetries) {
          goalGateRetries++;
          current = graph.nodes[retryTarget]!;
          continue;
        }
        const exhausted = retryTarget && goalGateRetries >= maxGoalGateRetries;
        finalOutcome = {
          ...result.finalOutcome,
          status: "fail",
          failure_reason: exhausted
            ? `goal gate(s) unsatisfied after ${maxGoalGateRetries} retries to "${retryTarget}": ${unsat.join(", ")}`
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

  const goal_gates_satisfied = unsatisfiedGoalGates(graph, node_outcomes).length === 0;

  if (finalOutcome.status === "fail") {
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
