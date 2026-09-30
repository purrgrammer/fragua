// Exit-tool builders + hydrated-prefix transcript scans (route / emit_output /
// abort). A node exits via exactly one terminating tool; each terminating tool
// must be called in isolation (D3) — the scans return `{ …, isolated }` and the
// callers fail a non-isolated exit. Split out of backend.ts.

import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Outcome, OutputsDecl, OutputsValue } from "@fragua/core";
import { compileOutputsToTypeBox, fail, failHalt, ok, validateOutputsValue } from "@fragua/core";
import { Type } from "@sinclair/typebox";

/** Resolve a clean-ended turn into its exit outcome: a self-abort (wins over
 * everything), a route pick (`routes:` nodes), an `emit_output` value
 * (`outputs:` nodes), or a plain `ok`. Each terminating tool must be called in
 * isolation (D3) — sharing its batch fails the node. */
export function resolveExitOutcome(args: {
  messages: readonly AgentMessage[];
  hydratedCount: number;
  nodeRoutes: string[] | undefined;
  outputsDecl: OutputsDecl | undefined;
}): Outcome {
  const { messages, hydratedCount, nodeRoutes, outputsDecl } = args;
  const lastAssistant = lastAssistantMessage(messages);
  const notes = lastAssistant ? fullAssistantText(lastAssistant).slice(0, 4_000) : "";
  const aborted = findAbortToolCall(messages.slice(hydratedCount));
  // Isolation (mirrors the route / emit_output exits, D3).
  if (aborted && !aborted.isolated) {
    return fail(
      "abort shared an assistant response with other tool calls — call it alone, with no other tools in the same turn",
      { non_retryable: true },
    );
  }
  if (aborted) return fail(aborted.reason, { notes, non_retryable: true });

  // Route-tool resolution — only when the node opted into `routes=`.
  if (Array.isArray(nodeRoutes) && nodeRoutes.length > 0) {
    const routeCall = findRouteToolCall(messages.slice(hydratedCount));
    if (routeCall == null) {
      return failHalt("route_not_picked", "agent ended turn without calling route()");
    }
    if (!routeCall.isolated) {
      return fail(
        "route() shared an assistant response with other tool calls — call it alone, with no other tools in the same turn",
        { non_retryable: true },
      );
    }
    return ok({ notes, route: routeCall.route });
  }

  // emit_output resolution for nodes that declare outputs: but no routes:.
  if (outputsDecl !== undefined) {
    const emitCall = findEmitOutputCall(messages.slice(hydratedCount));
    if (emitCall == null) {
      return fail("node declared outputs: but did not call emit_output", { non_retryable: true });
    }
    if (!emitCall.isolated) {
      return fail(
        "emit_output shared an assistant response with other tool calls — emit it alone, with no other tools in the same turn",
        { non_retryable: true },
      );
    }
    const valErr = validateOutputsValue(outputsDecl, emitCall.value);
    if (valErr !== null) {
      return fail(`emit_output value failed validation: ${valErr}`, { non_retryable: true });
    }
    return ok({ notes, outputs: emitCall.value as OutputsValue });
  }

  return ok({ notes });
}

export function summarizeMessage(message: { role: string; content?: unknown }): string {
  return fullAssistantText(message).slice(0, 4_000);
}

/** Concatenate every text block in an assistant message. Caller clips for
 *  storage. */
function fullAssistantText(message: { role: string; content?: unknown }): string {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
  const parts = message.content as Array<{ type: string; text?: string }>;
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

/** The last `assistant`-role message in the transcript, or `undefined`.
 *  The agent loop can end on a `toolResult` message — the `abort` tool
 *  sets `terminate: true`, so its result lands after the assistant turn
 *  that called it — but `notes` must still come from assistant text. */
export function lastAssistantMessage(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
): { role: string; content?: unknown } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant") return m;
  }
  return undefined;
}

/**
 * Scan the transcript for a call to the built-in `abort` tool. The agent
 * signals "I cannot proceed" by calling `abort({ reason })`; the tool sets
 * `terminate: true` so the loop stops after its batch. The contract is
 * taught by the tool's own description and documented in
 * `docs/handler-contract.md` § "Llm self-abort".
 *
 * Walks the whole message array — not just the last message — so the abort
 * still wins when it was emitted alongside other tool calls in a
 * non-terminating batch (the loop ran one more turn but the call is still
 * in the transcript). First `abort` call wins.
 *
 * The reason is trimmed and clamped so it can be surfaced as a
 * `failure_reason` without dragging in kilobytes of reasoning. Returns
 * `null` when no `abort` call is present.
 *
 * Exported so tests can rely on the exact contract without reimplementing
 * the scan.
 */
export function findAbortToolCall(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
): { reason: string; isolated: boolean } | null {
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const blocks = message.content as Array<{ type: string; name?: string; arguments?: Record<string, unknown> }>;
    let abortBlock: { arguments?: Record<string, unknown> } | undefined;
    let otherToolCalls = 0;
    for (const block of blocks) {
      if (block.type !== "toolCall") continue;
      if (block.name === "abort" && abortBlock === undefined) {
        abortBlock = block;
        continue;
      }
      otherToolCalls += 1;
    }
    if (abortBlock === undefined) continue;
    const rawReason = typeof abortBlock.arguments?.["reason"] === "string" ? abortBlock.arguments["reason"] : "";
    const reason = rawReason.replace(/\s+/g, " ").trim().slice(0, 400);
    return { reason: reason.length > 0 ? reason : "agent aborted without a reason", isolated: otherToolCalls === 0 };
  }
  return null;
}

/**
 * Scan the transcript for a call to the synthesised `route` tool.
 * The tool only exists for the lifetime of one llm call — see
 * `buildRouteTool` — and its sole effect is to terminate the agent
 * loop. The chosen route is recovered here from the assistant's
 * tool-call block.
 *
 * Returns `{ route, isolated }`:
 *  - `route`: the `name` argument from the first `route` tool-call block.
 *  - `isolated`: false when the assistant message containing the `route`
 *    call also contains any other `toolCall` block (any tool name). The
 *    isolation rule (D3) prevents side effects from sharing a response
 *    with the route exit — the model must commit to the route on a
 *    response of its own.
 *
 * **Last** `route` call wins. The transcript includes prior thread
 * history (shared `thread_id=` nodes pass their messages through), so
 * a forward scan would surface an UPSTREAM routing node's `route` call
 * instead of the one the current node just made — exactly what
 * happened in run `01ks012pq5jb5jyb0d` where `needs_human` correctly
 * called `route({name:"yes"})` but the scan returned triage's earlier
 * `route({name:"feature"})`. Iterating from the end recovers the
 * current node's choice; the `terminate: true` on the tool means the
 * current loop only emits one route call, so "last in transcript" is
 * always "this node's".
 *
 * Exported so tests can rely on the exact contract without
 * reimplementing the scan.
 */
export function findRouteToolCall(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
): { route: string; isolated: boolean } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const blocks = message.content as Array<{ type: string; name?: string; arguments?: Record<string, unknown> }>;
    let routeBlock: { name?: string; arguments?: Record<string, unknown> } | undefined;
    let otherToolCalls = 0;
    for (const block of blocks) {
      if (block.type !== "toolCall") continue;
      if (block.name === "route" && routeBlock === undefined) {
        routeBlock = block;
        continue;
      }
      otherToolCalls += 1;
    }
    if (routeBlock === undefined) continue;
    const raw = typeof routeBlock.arguments?.["name"] === "string" ? routeBlock.arguments["name"] : "";
    const route = raw.trim();
    return { route, isolated: otherToolCalls === 0 };
  }
  return null;
}

/** Corrective nudge replayed once when an outputs node ends its turn without
 * calling `emit_output` (see the in-loop re-prompt in `run`). */
export const EMIT_OUTPUT_REMINDER =
  "You ended your turn without calling `emit_output`, so this step is not complete. " +
  "Call `emit_output` exactly once now, on its own (no other tool calls in the same response), " +
  "with every declared output field present and correctly typed.";

/**
 * Build the `emit_output` tool for a node that declares `outputs:` but does NOT
 * route (a routing node carries its outputs on the `route` call instead).
 * Force-included (like `route`); one call closes the turn (`terminate: true`).
 * The schema is compiled from the node's `OutputsDecl` via `compileOutputsToTypeBox`.
 */
export function buildEmitOutputTool(decl: OutputsDecl): AgentTool {
  const parameters = compileOutputsToTypeBox(decl);
  return {
    name: "emit_output",
    label: "emit_output",
    description:
      "Emit the structured output for this step. Call exactly once when you have produced all declared output fields. " +
      "All declared fields must be present with their correct types. This call closes the turn — call it alone, " +
      "with no other tool calls in the same response (do all other work in earlier turns first).",
    parameters,
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: `emit_output called` }],
        details: { fragua_tool: "emit_output", is_error: false, data: params },
        terminate: true,
      };
    },
  };
}

/**
 * Scan the transcript for the last `emit_output` tool call.
 * Returns `{ value, isolated }`:
 *  - `value`: the raw arguments object from the `emit_output` block.
 *  - `isolated`: false when the assistant message containing the call also
 *    contains any other `toolCall` block. emit_output terminates the turn, so a
 *    tool sharing its batch runs but its result is discarded — the same D3
 *    isolation rule the `route` exit enforces (see `findRouteToolCall`).
 * Last call wins (like `findRouteToolCall`) to handle thread rehydration.
 */
export function findEmitOutputCall(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
): { value: unknown; isolated: boolean } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const blocks = message.content as Array<{ type: string; name?: string; arguments?: unknown }>;
    let emitBlock: { arguments?: unknown } | undefined;
    let otherToolCalls = 0;
    for (const block of blocks) {
      if (block.type !== "toolCall") continue;
      if (block.name === "emit_output" && emitBlock === undefined) {
        emitBlock = block;
        continue;
      }
      otherToolCalls += 1;
    }
    if (emitBlock === undefined) continue;
    return { value: emitBlock.arguments, isolated: otherToolCalls === 0 };
  }
  return null;
}

/**
 * Build the ephemeral `route` tool for one routing-node invocation.
 * Inline (not a static module): the enum is materialised from the
 * node's `routes=` attribute on every call. `terminate: true` ends
 * the agent loop after the call batch — same loop-stop mechanism as
 * the `abort` tool. The chosen route is recovered from the transcript
 * by `findRouteToolCall`; the tool's execute() output exists only to
 * satisfy pi-agent-core's tool-result contract.
 */
export function buildRouteTool(routes: readonly string[]): AgentTool {
  // Use a plain JSONSchema `enum` (via Type.Unsafe) rather than
  // `Type.Union(Type.Literal(...))`. The Union form lowers to
  // `anyOf: [{const: "yes"}, {const: "no"}]` which Anthropic's
  // tool-use validator does not enforce — off-list `name` values
  // reach the handler. A bare `{type:"string", enum:[...]}` is
  // enforced at the provider layer, so a wayward
  // `route({name:"feature"})` is rejected before it ever lands.
  const nameSchema = Type.Unsafe<string>({ type: "string", enum: [...routes] });
  const parameters = Type.Object({ name: nameSchema }, { additionalProperties: false });
  return {
    name: "route",
    label: "route",
    description:
      "Exit this node with the chosen route. Call exactly once when decided. Call this alone in the response; do not pair it with other tool calls.",
    parameters,
    async execute(_toolCallId, params) {
      const chosen = (params as { name: string }).name;
      return {
        content: [{ type: "text", text: `route: ${chosen}` }],
        details: { fragua_tool: "route", is_error: false, data: { route: chosen } },
        terminate: true,
      };
    },
  };
}
