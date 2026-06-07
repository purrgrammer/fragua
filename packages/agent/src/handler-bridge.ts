// handler-bridge — run a PiLlmBackend inside a HandlerContext.
//
// This is the integration point that drives an LLM-backed node. Given a
// ctx + a parsed Node, we build a LlmInput, run the backend, stream
// `emit` callbacks into
// ctx.messages + running token/cost totals, then translate the Outcome
// into a HandlerResult the executor can commit.

import {
  type EventType,
  type LlmBackend,
  type Node,
  type Outcome,
  substitute,
  UnpopulatedOutputError,
} from "@fragua/core";
import type * as handler from "@fragua/core/handler";
import { MessageTooLargeError } from "@fragua/store";
import type { AgentMessage } from "@fragua/types";
import { PiLlmBackend, type PiLlmBackendOptions } from "./backend.ts";
import { syntheticThreadId } from "./thread.ts";

export interface MakeLlmHandlerOpts {
  /**
   * The parsed graph node this handler corresponds to. The backend reads
   * `node.attrs.prompt`, `node.attrs.provider`, `node.attrs.model`, etc.
   */
  node: Node;
  /**
   * Fallback next-node id. When set, the executor uses it verbatim and
   * skips edge selection. Leave unset to defer to the executor's selectEdge.
   */
  nextNode?: string;
  /** Backend instance used to drive the LLM. In production this is a
   * `PiLlmBackend`; tests and mock workflows can pass any
   * `LlmBackend`. Provide this OR `backendOpts`. */
  backend?: LlmBackend;
  /** Builder used when `backend` is omitted. */
  backendOpts?: PiLlmBackendOptions;
  /** Hard per-call timeout; forwarded into HandlerSpec.maxMs.
   *
   *   - `number` — explicit ms ceiling; HandlerSpec.maxMs is set verbatim.
   *   - `"unbounded"` — per-node opt-out (sourced from `max_ms=0` /
   *     `timeout="0"` via the auto-dispatcher); HandlerSpec.maxMs is left
   *     absent so the executor skips AbortSignal.timeout and the leak
   *     watchdog.
   *   - `undefined` — author didn't specify; HandlerSpec.maxMs gets the
   *     4h DEFAULT_MAX_MS runaway backstop. */
  maxMs?: number | "unbounded";
}

type HandlerSpec = handler.HandlerSpec;
type HandlerContext = handler.HandlerContext;
type HandlerResult = handler.HandlerResult;

// Wall-clock is a runaway-detection backstop, not a typical-completion
// bound. Day-to-day capping is the job of cost / tokens / iterations /
// operator intents. Set this high enough that no legitimate workflow
// trips it; any handler that runs longer is pathologically stuck.
const DEFAULT_MAX_MS = 4 * 60 * 60 * 1000;

export function makeLlmHandler(opts: MakeLlmHandlerOpts): HandlerSpec {
  const backend: LlmBackend =
    opts.backend ??
    (opts.backendOpts != null
      ? new PiLlmBackend(opts.backendOpts)
      : (() => {
          throw new Error("makeLlmHandler: provide `backend` or `backendOpts`");
        })());

  const run: handler.Handler = async (ctx) => {
    const node = opts.node;
    const rawPrompt = typeof node.attrs.prompt === "string" ? node.attrs.prompt : "";
    // Resolve `${{ inputs.x }}` / `${{ outputs.X.f }}` before the prompt hits
    // the LLM. Without this the agent sees the literal placeholder and every
    // workflow with an abort-on-empty guard halts on its first node.
    // `wrapOutputs`: interpolated outputs are delimited with a SHA-256-derived
    // boundary so an upstream-laundered value can't pose as an instruction
    // (substitution.ts §6.4).
    // An unpopulated `${{ outputs.X.f }}` read FAILS CLOSED as a node `fail`
    // (routes via fail-edge / goal-gate / aborted_exit), never an uncaught throw
    // that the executor would turn into a fatal `reason:"error"` halt.
    let prompt: string;
    try {
      prompt = substitute(rawPrompt, { args: ctx.args, wrapOutputs: true });
    } catch (err) {
      if (err instanceof UnpopulatedOutputError) {
        return { kind: "transition", outcomeStatus: "fail", failureReason: err.message, tokens: 0, costUsd: 0 };
      }
      throw err;
    }
    const graphGoal = typeof ctx.routing["graph.goal"] === "string" ? (ctx.routing["graph.goal"] as string) : undefined;

    let tokens = 0;
    let costUsd = 0;
    let inputCostUsd = 0;
    let outputCostUsd = 0;
    let cacheReadCostUsd = 0;
    let cacheWriteCostUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let modelName: string | undefined;

    const emit = async (type: EventType, data: Record<string, unknown>) => {
      // Persist every agent/llm/tool/cost/summary event to the store so the
      // UI's conversation + step views have data to project. Writes are
      // buffered by the executor and flushed once per turn, not per event.
      ctx.emit(type, data);
      if (type === "cost.recorded") {
        tokens += numAt(data, "total_tokens");
        costUsd += numAt(data, "cost_usd");
        inputCostUsd += numAt(data, "cost_input_usd");
        outputCostUsd += numAt(data, "cost_output_usd");
        cacheReadCostUsd += numAt(data, "cost_cache_read_usd");
        cacheWriteCostUsd += numAt(data, "cost_cache_write_usd");
        inputTokens += numAt(data, "input_tokens");
        outputTokens += numAt(data, "output_tokens");
        cacheReadTokens += numAt(data, "cache_read_tokens");
        cacheWriteTokens += numAt(data, "cache_write_tokens");
        const model = strAt(data, "model");
        if (model != null) modelName = model;
      }
    };

    const explicitThreadId = strAt(node.attrs as Record<string, unknown>, "thread_id");
    // A node with no explicit `thread:` still gets a thread — a synthetic
    // one keyed by (nodeId, iteration). Without it an unthreaded node
    // re-dispatches against an empty agent and silently drops its
    // mid-flight transcript on every resume (budget, provider_retry,
    // timeout, daemon restart). The synthetic id reuses the same
    // persist/hydrate machinery as a real thread; keyed by iteration so a
    // fresh loop pass starts clean while a resume of the SAME entry
    // rehydrates — preserving unthreaded "fresh each entry" semantics.
    const isSyntheticThread = explicitThreadId === undefined;
    const threadId = explicitThreadId ?? syntheticThreadId(ctx.nodeId, ctx.iteration);
    // Resume hydration: load any prior messages for this dispatch that are
    // already in the messages table. This is the daemon-restart path —
    // in-process MessageStore is empty but the DB has the pre-crash
    // transcript. The backend compares the size of this load against its
    // `inProcessWrites` set to decide whether the dispatch is a resume.
    // An explicit thread loads its shared transcript (matched by node_id,
    // with a graph-level fallback); a synthetic thread loads only this
    // node's own rows for the current iteration.
    const priorMessages = isSyntheticThread ? loadPriorMessagesForNode(ctx) : loadPriorMessagesForThread(ctx, threadId);

    // Seed dedup memo from the LAST persisted system + user row for
    // this (run, nodeId, iteration). Re-dispatching the same node on
    // resume (operator pause + resume, raise & resume, provider-error
    // auto-resume) produces a byte-identical system prompt
    // (deterministic from node attrs) and re-passes the same input
    // prompt to `agent.prompt(effectivePrompt)`, which pi-agent
    // emits as a fresh user message_start/end. Without this memo
    // the messages table grows N × {system, user} rows per N
    // resume cycles, the conversation view shows visible
    // duplicates, and downstream LLM rehydration carries the bloat.
    // The walk must be length-INDEPENDENT: the system + seed-user are
    // the FIRST rows of the dispatch, so any bound on the tail (an
    // earlier version capped at 50) silently defeats dedup once a node
    // runs more turns than the bound before pausing. Scoped to the
    // current iteration so a fresh loop pass still seeds its own
    // system/user — only a resume of the same entry is deduped.
    let lastPersistedSystem: string | undefined;
    let lastPersistedUser: string | undefined;
    const nodeRows = ctx.messages.since(0).filter((m) => m.nodeId === ctx.nodeId && m.iteration === ctx.iteration);
    for (let i = nodeRows.length - 1; i >= 0; i--) {
      const row = nodeRows[i];
      if (row == null) continue;
      const m = row.content as { role: string; content: unknown };
      if (lastPersistedSystem === undefined && m.role === "system" && typeof m.content === "string") {
        lastPersistedSystem = m.content;
      }
      if (lastPersistedUser === undefined && m.role === "user") {
        lastPersistedUser = JSON.stringify(m.content);
      }
      if (lastPersistedSystem !== undefined && lastPersistedUser !== undefined) break;
    }

    const summary = node.attrs.summary;
    const outcome: Outcome = await backend.run({
      node,
      prompt,
      ...(graphGoal !== undefined ? { goal: graphGoal } : {}),
      thread_id: threadId,
      ...(summary !== undefined ? { summary } : {}),
      signal: ctx.signal,
      run_id: ctx.runId,
      workflow_sha: "",
      emit,
      ...(priorMessages !== undefined ? { priorMessages } : {}),
      ...(ctx.env !== undefined ? { env: ctx.env } : {}),
      ...(ctx.budgetSnapshot !== undefined ? { budgetSnapshot: ctx.budgetSnapshot } : {}),
      persistMessage: (message) => {
        // Dedup system + initial-user messages against the most
        // recent persisted ones for this (run, nodeId). See the
        // seed block above for the rationale.
        if (message.role === "system" && typeof message.content === "string") {
          if (lastPersistedSystem === message.content) return;
          lastPersistedSystem = message.content;
        } else if (message.role === "user") {
          const serialised = JSON.stringify(message.content);
          if (lastPersistedUser === serialised) return;
          lastPersistedUser = serialised;
        }
        try {
          ctx.messages.append(message);
          return;
        } catch (err) {
          if (!(err instanceof MessageTooLargeError)) throw err;
          // Spill the full message to an artifact so rehydration retains
          // a retrievable pointer, then persist a tiny placeholder whose
          // JSON serialisation comfortably fits under the 1 MiB message
          // cap. Dropping the message entirely would break the transcript
          // contract; crashing the handler would turn an oversized agent
          // turn into a failed run.
          let spillKey: string | undefined;
          try {
            spillKey = `__msg_spill_${Date.now()}`;
            ctx.artifacts.put(spillKey, JSON.stringify(message), "application/json");
          } catch {
            spillKey = undefined;
          }
          const detail = spillKey
            ? `[message too large (${err.sizeBytes} bytes); spilled to artifact ${spillKey}]`
            : `[message too large (${err.sizeBytes} bytes); spill failed]`;
          void emit("agent.warning", { message: detail });
          try {
            ctx.messages.append({
              role: message.role,
              content: [{ type: "text", text: detail }],
              timestamp: (message as { timestamp?: number }).timestamp ?? Date.now(),
            } as AgentMessage);
          } catch {
            // Placeholder somehow also over-limit — drop silently, the
            // warning event already landed.
          }
        }
      },
    });

    // Provider transport error: pause the run instead of halting so an
    // operator can `intent.resume` after fixing the upstream issue (top
    // up balance, rotate key, wait out a 5xx). The llm agent
    // boundary attaches `provider_error` when classifying a failed
    // stream; handlers never construct it themselves.
    if (outcome.provider_error != null) {
      const result: Extract<HandlerResult, { kind: "pause_provider" }> = {
        kind: "pause_provider",
        httpStatus: outcome.provider_error.httpStatus,
        provider: outcome.provider_error.provider,
        errorMessage: outcome.provider_error.errorMessage,
      };
      if (outcome.provider_error.retryAfterMs !== undefined) {
        result.retryAfterMs = outcome.provider_error.retryAfterMs;
      }
      return result satisfies HandlerResult;
    }

    // Hard-halt outcomes from the llm agent boundary
    // (`route_not_picked` / `route_call_not_isolated`). The backend
    // never constructs a
    // `HandlerResult.halt` itself; it signals via `outcome.halt_reason`
    // and we translate here so the executor's `case "halt"` path emits
    // `fact.run_halted` with the right reason. `failureReason` becomes
    // the halt `detail`. Restricted to the `halt` union's accepted
    // reasons via the type assertion below — the handler-contract halt
    // shape doesn't carry every HaltReason literal (some are
    // executor-only).
    if (outcome.halt_reason != null) {
      const result: Extract<HandlerResult, { kind: "halt" }> = {
        kind: "halt",
        reason: outcome.halt_reason as Extract<HandlerResult, { kind: "halt" }>["reason"],
      };
      if (outcome.failure_reason != null && outcome.failure_reason.length > 0) {
        result.detail = outcome.failure_reason;
      }
      return result satisfies HandlerResult;
    }

    // retry outcomes flow through as transitions: the executor consults
    // retryStep (engine/retry-policy.ts) on outcomeStatus="retry" to decide
    // between sleep+re-dispatch, halt(max_retries_exceeded), or
    // advance_partial (for nodes with allow_partial=true).

    // `fail` outcomes flow through as transitions so the executor's edge
    // selector can route to an `outcome=fail` recovery edge. When no
    // fail-edge exists, selectEdge returns undefined and the executor halts.
    const failureReason =
      outcome.status === "fail" && outcome.failure_reason != null && outcome.failure_reason.length > 0
        ? outcome.failure_reason
        : undefined;
    // Only set `nextNode` for explicit overrides — otherwise the executor's
    // edge selector picks based on the outcome fields below. `opts.nextNode`
    // is a fallback for auto-dispatcher code paths that pre-compute a single
    // outgoing edge (noop transition nodes).
    const explicitNext = opts.nextNode;

    const result: HandlerResult = {
      kind: "transition",
      outcomeStatus: outcome.status,
      ...(outcome.route !== undefined && outcome.route.length > 0 ? { route: outcome.route } : {}),
      ...(outcome.outputs !== undefined ? { outputs: outcome.outputs } : {}),
      ...(explicitNext != null ? { nextNode: explicitNext } : {}),
      ...(failureReason !== undefined ? { failureReason } : {}),
      tokens,
      costUsd,
      inputCostUsd,
      outputCostUsd,
      cacheReadCostUsd,
      cacheWriteCostUsd,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(modelName !== undefined ? { modelName } : {}),
    };
    return result;
  };

  const spec: HandlerSpec = {
    kind: "llm",
    sideEffect: "external",
    handler: run,
  };
  if (opts.maxMs === "unbounded") {
    // Explicit opt-out via `max-ms: 0` in the workflow YAML — leave HandlerSpec.maxMs absent.
  } else if (typeof opts.maxMs === "number") {
    spec.maxMs = opts.maxMs;
  } else {
    spec.maxMs = DEFAULT_MAX_MS;
  }
  return spec;
}

function numAt(data: Record<string, unknown>, key: string): number {
  const v = data[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function strAt(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  return typeof v === "string" ? v : undefined;
}

/** Hydrate the pi-agent-core `AgentMessage[]` history for a
 * (runId, threadId) pair from the `messages` table. Rows store the
 * full AgentMessage as JSON (§I9), so this is a read-and-filter — no
 * synthesis, no shape reconstruction. Filters by `node_id` when the
 * thread id equals a node id (the common case); falls back to all
 * graph-level messages otherwise so authors who set `thread_id="dev"`
 * get their cross-node history. Fragua-internal `system` rows (the
 * assembled system prompt — pi-ai carries it separately via
 * `Context.systemPrompt`) and `tool_node` rows (graph-level shell
 * step output, not conversational; pi-ai's `Message` union has no
 * such role) are stripped.
 *
 * Returns `undefined` when nothing is persisted. */
function loadPriorMessagesForThread(ctx: HandlerContext, threadId: string): readonly AgentMessage[] | undefined {
  const graphLevel = ctx.messages.since(0);
  const byNode = graphLevel.filter((m) => m.nodeId === threadId);
  const rows = byNode.length > 0 ? byNode : graphLevel;
  if (rows.length === 0) return undefined;
  const messages = rows.map((row) => row.content).filter((m) => m.role !== "system" && m.role !== "tool_node");
  return messages.length > 0 ? messages : undefined;
}

// Hydration source for a synthetic per-node thread: this node's own rows
// for the current iteration. Iteration-scoped so a resumed dispatch restores
// exactly the entry it's resuming and a fresh loop pass starts clean. The
// `system` row is re-seeded each dispatch (and deduped on persist), and
// `tool_node` rows are side-effect captures, not LLM-visible turns — both
// are dropped, matching `loadPriorMessagesForThread`.
function loadPriorMessagesForNode(ctx: HandlerContext): readonly AgentMessage[] | undefined {
  const rows = ctx.messages.since(0).filter((m) => m.nodeId === ctx.nodeId && m.iteration === ctx.iteration);
  if (rows.length === 0) return undefined;
  const messages = rows.map((row) => row.content).filter((m) => m.role !== "system" && m.role !== "tool_node");
  return messages.length > 0 ? messages : undefined;
}

export type { HandlerSpec, HandlerContext };
