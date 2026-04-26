// handler-bridge — run a PiCodergenBackend inside a HandlerContext.
//
// This is the integration point that turns the DB-backed rearchitecture
// into a real LLM-driven orchestrator. Given a ctx + a parsed Node, we
// build a CodergenInput, run the backend, stream `emit` callbacks into
// ctx.messages + running token/cost totals, then translate the Outcome
// into a HandlerResult the executor can commit.

import {
  type CodergenBackend,
  type ContextMap,
  type EventType,
  type Node,
  type Outcome,
  substitute,
} from "@swarm/core";
import type * as handler from "@swarm/core/handler";
import { MessageTooLargeError } from "@swarm/store";
import type { AgentMessage } from "@swarm/types";
import { PiCodergenBackend, type PiCodergenBackendOptions } from "./backend.ts";

export interface MakeCodergenHandlerOpts {
  /**
   * The parsed graph node this handler corresponds to. The backend reads
   * `node.attrs.prompt`, `node.attrs.provider`, `node.attrs.model`, etc.
   */
  node: Node;
  /**
   * Fallback next-node id used only if the backend returns no
   * `next_node_override` and the caller wants to bypass edge selection.
   * Leave unset to defer to the executor's selectEdge. */
  nextNode?: string;
  /** Backend instance used to drive the LLM. In production this is a
   * `PiCodergenBackend`; tests and mock workflows can pass any
   * `CodergenBackend`. Provide this OR `backendOpts`. */
  backend?: CodergenBackend;
  /** Builder used when `backend` is omitted. */
  backendOpts?: PiCodergenBackendOptions;
  /** Hard per-call timeout; forwarded into HandlerSpec.maxMs. Default 30 min
   * (see DEFAULT_MAX_MS below for rationale). */
  maxMs?: number;
  /** Default ContextMap passed as CodergenInput.context. Merged with
   * ctx.routing at call time. */
  defaultContext?: ContextMap;
}

type HandlerSpec = handler.HandlerSpec;
type HandlerContext = handler.HandlerContext;
type HandlerResult = handler.HandlerResult;

// Safety net for runaway tool loops, not a policy ceiling for legitimately
// long agent work. Drop this cap once budget enforcement lands
// (docs/ARCHITECTURE.md §13.1) — the $-budget is the correct fence; a
// wall-clock ceiling is just a proxy for "something is wedged".
const DEFAULT_MAX_MS = 30 * 60 * 1000;

export function makeCodergenHandler(opts: MakeCodergenHandlerOpts): HandlerSpec {
  const backend: CodergenBackend =
    opts.backend ??
    (opts.backendOpts != null
      ? new PiCodergenBackend(opts.backendOpts)
      : (() => {
          throw new Error("makeCodergenHandler: provide `backend` or `backendOpts`");
        })());

  const run: handler.Handler = async (ctx) => {
    const node = opts.node;
    const rawPrompt = typeof node.attrs.prompt === "string" ? node.attrs.prompt : "";
    const context = mergeContext(opts.defaultContext, ctx.routing);
    // Substitute $ARGUMENTS, ${context.*}, and $<nodeId>.output[.path]
    // before the prompt hits the LLM. Without this the agent sees the
    // literal placeholder and every workflow with an abort-on-empty
    // guard halts on its first node.
    const prompt = substitute(rawPrompt, { args: ctx.args, context });

    let tokens = 0;
    let costUsd = 0;
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
        inputTokens += numAt(data, "input_tokens");
        outputTokens += numAt(data, "output_tokens");
        cacheReadTokens += numAt(data, "cache_read_tokens");
        cacheWriteTokens += numAt(data, "cache_write_tokens");
        const model = strAt(data, "model");
        if (model != null) modelName = model;
      }
    };

    const threadId = strAt(node.attrs as Record<string, unknown>, "thread_id");
    // Resume hydration: load any prior messages for this (run, thread)
    // that are already in the messages table. This is the daemon-
    // restart path — in-process MessageStore is empty but the DB has
    // the pre-crash transcript. The backend compares the size of this
    // load against its `inProcessWrites` set to decide whether to
    // apply SPEC §3.6 degrade on fidelity=full.
    const priorMessages = threadId ? loadPriorMessagesForThread(ctx, threadId) : undefined;

    const outcome: Outcome = await backend.run({
      node,
      prompt,
      context,
      thread_id: threadId,
      fidelity: (node.attrs.fidelity ?? "full") as NonNullable<Node["attrs"]["fidelity"]>,
      signal: ctx.signal,
      run_id: ctx.runId,
      workflow_sha: "",
      emit,
      ...(priorMessages !== undefined ? { priorMessages } : {}),
      ...(ctx.env !== undefined ? { env: ctx.env } : {}),
      ...(ctx.budgetSnapshot !== undefined ? { budgetSnapshot: ctx.budgetSnapshot } : {}),
      persistMessage: (message) => {
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
    // up balance, rotate key, wait out a 5xx). The codergen agent
    // boundary attaches `provider_error` when classifying a failed
    // stream; handlers never construct it themselves.
    if (outcome.provider_error != null) {
      return {
        kind: "pause_provider",
        httpStatus: outcome.provider_error.httpStatus,
        provider: outcome.provider_error.provider,
        errorMessage: outcome.provider_error.errorMessage,
      } satisfies HandlerResult;
    }

    if (outcome.status === "retry" || outcome.status === "partial_success") {
      // Treat retries as halt for now — a richer retry strategy can fold
      // outcome.context_updates back into routing and re-enter the node.
      return {
        kind: "halt",
        reason: "error",
        detail: outcome.failure_reason ?? `codergen status=${outcome.status}`,
      } satisfies HandlerResult;
    }

    // `fail` outcomes flow through as transitions so the executor's edge
    // selector can route to a `condition="outcome=fail"` recovery edge
    // (e.g. build-feature.dot: `review -> fix`). When no fail-edge exists,
    // selectEdge returns undefined and the executor halts via
    // result-to-facts' `outcomeStatus === "fail" → fact.run_halted` branch
    // — same observable end state as before, just authored through the
    // workflow graph instead of short-circuited here.
    const routingDelta = contextUpdatesToRouting(outcome.context_updates);
    if (outcome.status === "fail" && outcome.failure_reason != null && outcome.failure_reason.length > 0) {
      routingDelta["__failure_reason"] = outcome.failure_reason;
    }
    // Only set `nextNode` for explicit overrides — otherwise the executor's
    // edge selector picks based on the outcome fields below. `opts.nextNode`
    // stays as a legacy-compat fallback for auto-dispatcher code paths that
    // pre-compute a single outgoing edge (noop transition nodes).
    const explicitNext = outcome.next_node_override ?? opts.nextNode;
    const result: HandlerResult = {
      kind: "transition",
      outcomeStatus: outcome.status,
      ...(outcome.preferred_label.length > 0 ? { preferredLabel: outcome.preferred_label } : {}),
      ...(outcome.suggested_next_ids.length > 0 ? { suggestedNextIds: outcome.suggested_next_ids } : {}),
      ...(explicitNext != null ? { nextNode: explicitNext } : {}),
      tokens,
      costUsd,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(Object.keys(routingDelta).length > 0 ? { routingDelta } : {}),
      ...(modelName !== undefined ? { modelName } : {}),
    };
    return result;
  };

  return {
    kind: "codergen",
    sideEffect: "external",
    maxMs: opts.maxMs ?? DEFAULT_MAX_MS,
    handler: run,
  };
}

function mergeContext(defaults: ContextMap | undefined, routing: Readonly<Record<string, unknown>>): ContextMap {
  const out: ContextMap = { ...(defaults ?? {}) };
  for (const [k, v] of Object.entries(routing)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v as ContextMap[string];
    }
  }
  return out;
}

function contextUpdatesToRouting(updates: Outcome["context_updates"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updates)) out[k] = v;
  return out;
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
 * messages otherwise so authors who set `thread_id="dev"` get their
 * cross-node history. Swarm-internal `role:"system"` rows (the stored
 * system prompt) are stripped — pi-ai carries the system prompt
 * separately on each call via `Context.systemPrompt`. Returns
 * `undefined` when nothing is persisted. */
function loadPriorMessagesForThread(ctx: HandlerContext, threadId: string): readonly AgentMessage[] | undefined {
  const byNode = ctx.messages.since(0).filter((m) => m.nodeId === threadId);
  const rows = byNode.length > 0 ? byNode : ctx.messages.since(0);
  if (rows.length === 0) return undefined;
  const messages = rows.map((row) => row.content).filter((m) => m.role !== "system");
  return messages.length > 0 ? messages : undefined;
}

export type { HandlerSpec, HandlerContext };
