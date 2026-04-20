// handler-bridge — run a PiCodergenBackend inside a HandlerContext.
//
// This is the integration point that turns the DB-backed rearchitecture
// into a real LLM-driven orchestrator. Given a ctx + a parsed Node, we
// build a CodergenInput, run the backend, stream `emit` callbacks into
// ctx.messages + running token/cost totals, then translate the Outcome
// into a HandlerResult the executor can commit.

import { type CodergenBackend, type ContextMap, type EventType, type Node, type Outcome, substitute } from "@swarm/core";
import type * as handler from "@swarm/core/handler";
import { PiCodergenBackend, type PiCodergenBackendOptions } from "./backend.ts";

export interface MakeCodergenHandlerOpts {
  /**
   * The parsed graph node this handler corresponds to. The backend reads
   * `node.attrs.prompt`, `node.attrs.provider`, `node.attrs.model`, etc.
   */
  node: Node;
  /** The edge target this node transitions to on success. */
  nextNode: string;
  /** Backend instance used to drive the LLM. In production this is a
   * `PiCodergenBackend`; tests and mock workflows can pass any
   * `CodergenBackend`. Provide this OR `backendOpts`. */
  backend?: CodergenBackend;
  /** Builder used when `backend` is omitted. */
  backendOpts?: PiCodergenBackendOptions;
  /** Hard per-call timeout; forwarded into HandlerSpec.maxMs. Default 5 min. */
  maxMs?: number;
  /** Default ContextMap passed as CodergenInput.context. Merged with
   * ctx.routing at call time. */
  defaultContext?: ContextMap;
}

type HandlerSpec = handler.HandlerSpec;
type HandlerContext = handler.HandlerContext;
type HandlerResult = handler.HandlerResult;

const DEFAULT_MAX_MS = 5 * 60 * 1000;

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
    // Substitute $ARGUMENTS / $RUN_ID / etc. before the prompt hits the
    // LLM. Without this the agent sees the literal placeholder and every
    // workflow with an abort-on-empty guard halts on its first node.
    const prompt = substitute(rawPrompt, { args: ctx.args, context });

    let tokens = 0;
    let costUsd = 0;
    let modelName: string | undefined;

    const emit = async (type: EventType, data: Record<string, unknown>) => {
      if (type === "cost.recorded") {
        tokens += numAt(data, "total_tokens");
        costUsd += numAt(data, "cost_usd");
        const model = strAt(data, "model");
        if (model != null) modelName = model;
      } else if (type === "agent.message_end") {
        const role = strAt(data, "role");
        const content = extractTextFromMessage(data);
        if (content.length > 0 && (role === "assistant" || role === "tool" || role === "user" || role === "system")) {
          ctx.messages.append(role, content);
        }
      }
    };

    const outcome: Outcome = await backend.run({
      node,
      prompt,
      context,
      thread_id: strAt(node.attrs as Record<string, unknown>, "thread_id"),
      fidelity: (node.attrs.fidelity ?? "full") as NonNullable<Node["attrs"]["fidelity"]>,
      signal: ctx.signal,
      run_id: ctx.runId,
      workflow_sha: "",
      emit,
    });

    if (outcome.status === "fail") {
      return {
        kind: "halt",
        reason: "error",
        detail: outcome.failure_reason ?? "codergen failed",
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

    const nextNode = outcome.next_node_override ?? opts.nextNode;
    const routingDelta = contextUpdatesToRouting(outcome.context_updates);
    const result: HandlerResult = {
      kind: "transition",
      nextNode,
      tokens,
      costUsd,
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

function extractTextFromMessage(data: Record<string, unknown>): string {
  const msg = data["message"];
  if (msg == null || typeof msg !== "object") return "";
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") parts.push(item);
      else if (item != null && typeof item === "object") {
        const text = (item as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    return parts.join("");
  }
  return "";
}

export type { HandlerSpec, HandlerContext };
