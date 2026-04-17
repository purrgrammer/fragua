// Main execution loop. Pure orchestration: parses, validates, dispatches to
// handlers, emits events, and returns an ExecutionResult. No I/O.
//
// See docs/SPEC.md §4.

import { selectEdge } from "../engine/edge-selection.ts";
import { resolveFidelity, resolveThreadId } from "../engine/fidelity.ts";
import { type NodeOutput, substitute } from "../engine/substitution.ts";
import { type EventSink, InMemorySink } from "../events/sink.ts";
import { AutoApproveInterviewer } from "../interviewer/index.ts";
import { type ContextMap, ENGINE_CONTEXT_KEYS, retryCountKey } from "../types/context.ts";
import type { Event, EventType } from "../types/events.ts";
import type { FidelityMode } from "../types/fidelity.ts";
import { type Graph, handlerOf, isTerminal, type Node } from "../types/graph.ts";
import type { Interviewer } from "../types/interviewer.ts";
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

const codergenHandler: Handler = async (ctx) => {
  const prompt = substitute(ctx.node.attrs.prompt ?? "", {
    context: ctx.context,
    nodeOutputs: ctx.node_outputs,
  });
  const fidelity = resolveFidelity({ graph: ctx.graph, edge: undefined, targetNode: ctx.node });
  const thread_id = resolveThreadId({ graph: ctx.graph, edge: undefined, targetNode: ctx.node });

  const emit = async (type: EventType, data: Record<string, unknown>): Promise<void> => {
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

  try {
    return await ctx.backend.run({
      node: ctx.node,
      prompt,
      context: ctx.context,
      thread_id,
      fidelity,
      signal: ctx.signal,
      run_id: ctx.run_id,
      workflow_sha: ctx.workflow_sha,
      emit,
    });
  } catch (err) {
    return fail(`codergen crashed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

export const HANDLERS: Record<string, Handler> = {
  start: startHandler,
  exit: exitHandler,
  conditional: conditionalHandler,
  codergen: codergenHandler,
};

// ---------------------------------------------------------------------------
// Execute

export interface ExecuteOptions {
  graph: Graph;
  /** Optional pre-computed SHA of the workflow source. Stored on every event. */
  workflow_sha?: string;
  /** Opaque id for this run. If omitted, a deterministic one is generated. */
  run_id?: string;
  /** Starting context values. `graph.*` keys are mirrored automatically. */
  initial_context?: Record<string, unknown>;
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

  await emit("pipeline.started", undefined, { graph_id: graph.id });

  let current: Node | null = findStart(graph);
  let steps = 0;
  let finalOutcome: Outcome = ok({ notes: "pipeline completed" });

  while (current) {
    if (steps++ >= max_steps) {
      finalOutcome = { ...finalOutcome, status: "fail", failure_reason: `exceeded max_steps=${max_steps}` };
      break;
    }
    if (signal.aborted) {
      finalOutcome = { ...finalOutcome, status: "fail", failure_reason: "aborted" };
      break;
    }

    const node: Node = current;
    const handler = handlers[handlerOf(node)];
    if (!handler) {
      finalOutcome = { ...finalOutcome, status: "fail", failure_reason: `no handler for shape "${node.shape}"` };
      await emit("node.failed", node, { reason: `no handler for "${node.shape}"` });
      break;
    }

    await emit("node.started", node, {});
    const startAt = Date.now();

    const outcome = await runWithRetry({
      handler,
      node,
      graph,
      context,
      run_id,
      workflow_sha,
      sink,
      interviewer,
      backend,
      signal,
      now,
      random,
      node_outputs,
      retry_counts,
    });

    const duration_ms = Date.now() - startAt;

    for (const [k, v] of Object.entries(outcome.context_updates)) context[k] = v;
    context[ENGINE_CONTEXT_KEYS.outcome] = outcome.status;
    if (outcome.preferred_label) context[ENGINE_CONTEXT_KEYS.preferred_label] = outcome.preferred_label;
    context[ENGINE_CONTEXT_KEYS.current_node] = node.id;
    context[ENGINE_CONTEXT_KEYS.last_stage] = node.id;

    if (outcome.status === "success" || outcome.status === "partial_success") {
      node_outputs.set(node.id, { success: true, output: outcome.notes, timestamp: Date.now() });
    }

    completed_nodes.push(node.id);
    node_outcomes[node.id] = outcome;

    await emit("node.completed", node, {
      outcome,
      duration_ms,
      retry_count: retry_counts[node.id] ?? 0,
    });

    if (isTerminal(node) && node.shape === "Msquare") {
      const unsat = unsatisfiedGoalGates(graph, node_outcomes);
      if (unsat.length > 0) {
        const retryTarget = graph.attrs.retry_target ?? graph.attrs.fallback_retry_target;
        if (retryTarget && graph.nodes[retryTarget]) {
          current = graph.nodes[retryTarget]!;
          continue;
        }
        finalOutcome = {
          ...finalOutcome,
          status: "fail",
          failure_reason: `goal gate(s) unsatisfied: ${unsat.join(", ")}`,
        };
        break;
      }
      finalOutcome = ok({ notes: "pipeline completed" });
      break;
    }

    const selection = selectEdge({ graph, source: node, outcome, context });
    if (!selection) {
      finalOutcome = outcome.status === "fail" ? outcome : ok({ notes: "pipeline completed (no outgoing edge)" });
      break;
    }

    await emit("edge.selected", node, {
      from: selection.edge.from,
      to: selection.edge.to,
      rule: selection.rule,
      ...(selection.matched !== undefined ? { matched: selection.matched } : {}),
    });

    const next = graph.nodes[selection.edge.to];
    if (!next) {
      finalOutcome = { ...finalOutcome, status: "fail", failure_reason: `missing node "${selection.edge.to}"` };
      break;
    }
    current = next;
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
