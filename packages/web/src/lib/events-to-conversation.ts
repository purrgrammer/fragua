// events-to-conversation — pure reducer folding a swarm event stream into
// a conversation tree for the AI-Elements-driven run view (P5.08).
//
// Design notes:
//
//   - The reducer is pure in the strictest sense: (events, initialState?)
//     → conversation. Same input ⇒ deep-equal output. No Date.now(), no
//     I/O, no randomness. This is what lets tests feed the same events
//     twice and compare with `expect.toEqual`.
//
//   - We scope sections by `node_id`. Events missing `node_id` (run
//     lifecycle: `run.*`, `edge.*`, `interview.*`, `checkpoint.*`,
//     `steering.requested`, ...) never produce conversation content — but
//     `node.started|completed|failed|retrying|skipped` still drive the
//     `NodeSection.status` projection. `steering.injected` *does* carry a
//     `node_id` (stamped by the executor's `buildEmit`) and renders as a
//     user message inside the active section/turn.
//
//   - Turns: one `Turn` per `agent.turn_start` within the current node
//     section. A node that retries via a backward edge three times emits
//     three turn_starts inside the *same* node_id, so those three turns
//     all live under one section — matching the spec's "three turns in
//     one section, not three sections" rule.
//
//   - Messages: `agent.message_start` opens, `agent.message_end` closes.
//     Messages are attached to the active turn; if an `agent.message_*`
//     arrives before any `agent.turn_start`, we synthesize an implicit
//     turn to host it (some event streams open the first user tool-
//     result message *before* the turn_start that wraps it — be liberal).
//
//   - Text / reasoning deltas append to the *last* matching part of the
//     active message. Creating one on first delta matches the spec.
//     Reasoning is **consolidated** into at most one `reasoning` part
//     per Message (AI Elements' `Reasoning` expects one block).
//
//   - `llm.done` (when emitted — swarm's current event bridge doesn't
//     always emit it) flips `streaming=false` on all streaming parts in
//     the active message. We also flush streaming on `agent.message_end`
//     as a fallback, because pi-agent-core sometimes short-circuits
//     `llm.done`. Either way streaming-pill behaviour is deterministic.
//
//   - Tool calls: `llm.toolcall_delta` deltas carry `{delta, content_index}`
//     — they're JSON-encoded argument chunks, opaque mid-stream. We
//     create a placeholder tool_call part keyed by `content_index` with
//     `state: "input-streaming"` and an accumulated `rawDelta` string
//     (stored on the part for debugging only; not surfaced in the type).
//     When `tool.execution_start` fires with `{tool_call_id, tool_name,
//     args}`, we bind the next unresolved placeholder in the turn to it
//     and flip state to `"input-available"`. `tool.execution_end` flips
//     to `"output-available"` (or `"output-error"` when `is_error`).
//
//   - Cost / tokens / model: `cost.recorded` attaches to the *most
//     recent assistant Message in the current turn*. The attribution is
//     by recency rather than id because swarm's `cost.recorded` doesn't
//     carry a message id.
//
// Keep this file I/O-free and dependency-light: it's imported both by
// the component and by tests that don't install happy-dom.

import type { SSEEvent } from "./useSSE.ts";

export type NodeSectionStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "retrying";

export interface NodeSection {
  nodeId: string;
  status: NodeSectionStatus;
  turns: Turn[];
  /** Node-level observability — populated from `node.started` and (for
   * LLM-driven handlers) the resolved LLM call on `llm.start`. All
   * optional so non-LLM sections (start / exit / conditional) stay bare. */
  nodeType?: string;
  promptTemplate?: string;
  /** Fully substituted prompt sent to the LLM. For loop nodes, this is
   * the most recent iteration's prompt — earlier iterations flow through
   * as new `llm.start` events that overwrite this slot. */
  prompt?: string;
  systemPrompt?: string;
  model?: string;
  provider?: string;
  threadId?: string;
  fidelity?: string;
  allowedTools?: string[];
  deniedTools?: string[];
  contextFiles?: string[];
  contextKeys?: string[];
  nodeOutputsInScope?: string[];
}

export interface Turn {
  turnId: string;
  sessionId?: string;
  messages: Message[];
}

export interface Message {
  /** Stable id — `${turnId}-m${n}` — for React keys and test selectors. */
  messageId: string;
  role: "assistant" | "user" | "system";
  parts: Part[];
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  modelId?: string;
}

export type Part = TextPart | ReasoningPart | ToolCallPart;

export interface TextPart {
  type: "text";
  text: string;
  streaming?: boolean;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
  streaming?: boolean;
}

export type ToolCallState = "input-streaming" | "input-available" | "output-available" | "output-error";

export interface ToolCallPart {
  type: "tool_call";
  /** Content-index slot from the provider stream; stable within a message. */
  contentIndex?: number;
  /** Filled when `tool.execution_start` fires. */
  toolCallId: string;
  toolName: string;
  input: unknown;
  state: ToolCallState;
  output?: unknown;
  errorText?: string;
}

export type RunConversation = NodeSection[];

/** Minimal shape of the raw event records the reducer consumes. */
export interface RawEvent {
  type: string;
  node_id?: string | null;
  session_id?: string | null;
  data?: Record<string, unknown> | null;
  /** Preserved so consumers can sort, but the reducer trusts input order. */
  timestamp?: string;
}

/** Parse a batch of `SSEEvent` records (as emitted by `useSSE`) into RawEvents. */
export function parseSSEEvents(events: readonly SSEEvent[]): RawEvent[] {
  const out: RawEvent[] = [];
  for (const e of events) {
    try {
      const parsed = JSON.parse(e.data) as Record<string, unknown>;
      // Shape assertion is cheap; bail if it's not an object.
      if (parsed && typeof parsed === "object") {
        out.push({
          type: String(parsed["type"] ?? e.type),
          node_id: (parsed["node_id"] ?? null) as string | null,
          session_id: (parsed["session_id"] ?? null) as string | null,
          data: (parsed["data"] ?? null) as Record<string, unknown> | null,
          timestamp: parsed["timestamp"] as string | undefined,
        });
      }
    } catch {
      // Skip unparseable frames. Not our job to recover — the server's
      // SSE encoder should never emit anything but valid JSON.
    }
  }
  return out;
}

/**
 * Opaque reducer state — holds the in-progress tree plus active-turn /
 * active-message pointers. Callers should treat this as a black box and
 * round-trip it through `createReducerState`, `applyEvent`, and
 * `toConversation`. Fields are exposed so tests can assert against them
 * but are not part of the stable public API.
 *
 * State is mutated in place by `applyEvent`. The conversation tree is the
 * only thing we keep around — raw events can be dropped after folding,
 * which is how we handle unbounded-length runs on the client.
 */
export interface ReducerState {
  sections: Map<string, NodeSection>;
  activeNodeId: string | null;
  activeTurn: Turn | null;
  activeMessage: Message | null;
  turnCounter: number;
  messageCounter: number;
}

/** Fresh, empty reducer state. */
export function createReducerState(): ReducerState {
  return {
    sections: new Map(),
    activeNodeId: null,
    activeTurn: null,
    activeMessage: null,
    turnCounter: 0,
    messageCounter: 0,
  };
}

/** Project the reducer state into the public `RunConversation` tree.
 * Always returns a fresh array; state is not aliased into the output so
 * callers can hand it to React without fear of mutation after the fact. */
export function toConversation(state: ReducerState): RunConversation {
  return Array.from(state.sections.values());
}

function sectionFor(state: ReducerState, nodeId: string): NodeSection {
  let s = state.sections.get(nodeId);
  if (!s) {
    s = { nodeId, status: "pending", turns: [] };
    state.sections.set(nodeId, s);
  }
  return s;
}

function openTurn(state: ReducerState, nodeId: string, sessionId: string | null | undefined): Turn {
  state.turnCounter += 1;
  const turn: Turn = {
    turnId: `${nodeId}-t${state.turnCounter}`,
    messages: [],
  };
  if (sessionId) turn.sessionId = sessionId;
  sectionFor(state, nodeId).turns.push(turn);
  return turn;
}

function openMessage(state: ReducerState, role: Message["role"]): Message {
  if (!state.activeTurn) {
    // Defensive: message_start before any turn_start. Synthesize one.
    if (!state.activeNodeId) {
      // Hard-drop: no node context at all. Allocate a synthetic bucket.
      state.activeNodeId = "__prelude__";
    }
    state.activeTurn = openTurn(state, state.activeNodeId, null);
  }
  state.messageCounter += 1;
  const msg: Message = {
    messageId: `${state.activeTurn.turnId}-m${state.messageCounter}`,
    role,
    parts: [],
  };
  state.activeTurn.messages.push(msg);
  return msg;
}

function lastPart<T extends Part["type"]>(msg: Message, type: T): Extract<Part, { type: T }> | undefined {
  for (let i = msg.parts.length - 1; i >= 0; i--) {
    const p = msg.parts[i];
    if (p && p.type === type) return p as Extract<Part, { type: T }>;
  }
  return undefined;
}

function appendTextDelta(state: ReducerState, delta: string): void {
  if (!state.activeMessage) state.activeMessage = openMessage(state, "assistant");
  const last = lastPart(state.activeMessage, "text");
  if (last?.streaming) {
    last.text += delta;
    return;
  }
  state.activeMessage.parts.push({ type: "text", text: delta, streaming: true });
}

function appendReasoningDelta(state: ReducerState, delta: string): void {
  if (!state.activeMessage) state.activeMessage = openMessage(state, "assistant");
  // Consolidate: always append to the single reasoning part if it exists,
  // regardless of whether newer parts (text / tool) were interleaved.
  // Matches the "one Reasoning block per Message" rule.
  const existing = lastPart(state.activeMessage, "reasoning");
  if (existing) {
    existing.text += delta;
    existing.streaming = true;
    return;
  }
  state.activeMessage.parts.push({ type: "reasoning", text: delta, streaming: true });
}

function appendToolcallDelta(state: ReducerState, contentIndex: number, delta: string): void {
  if (!state.activeMessage) state.activeMessage = openMessage(state, "assistant");
  // Look for an existing tool_call part at this content_index in the
  // current message. If present, accumulate; otherwise allocate.
  let slot: ToolCallPart | undefined;
  for (let i = state.activeMessage.parts.length - 1; i >= 0; i--) {
    const p = state.activeMessage.parts[i];
    if (p && p.type === "tool_call" && p.contentIndex === contentIndex) {
      slot = p;
      break;
    }
  }
  if (!slot) {
    slot = {
      type: "tool_call",
      contentIndex,
      toolCallId: "",
      toolName: "",
      input: undefined,
      state: "input-streaming",
    };
    state.activeMessage.parts.push(slot);
  }
  // Stash the raw accumulated JSON on `input` as a string while we stream.
  // Replaced with the parsed `args` on `tool.execution_start`.
  if (typeof slot.input === "string") slot.input = slot.input + delta;
  else if (slot.input === undefined) slot.input = delta;
}

function flushStreamingInMessage(msg: Message): void {
  for (const p of msg.parts) {
    if (p.type === "text" || p.type === "reasoning") {
      if (p.streaming) p.streaming = false;
    }
  }
}

function findUnboundToolCallInTurn(turn: Turn): ToolCallPart | undefined {
  // Scan from the most recent message backwards: the next tool execution
  // targets the latest pending placeholder.
  for (let i = turn.messages.length - 1; i >= 0; i--) {
    const m = turn.messages[i];
    if (!m) continue;
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j];
      if (p && p.type === "tool_call" && !p.toolCallId) return p;
    }
  }
  return undefined;
}

function findToolCallByIdInSection(section: NodeSection, toolCallId: string): ToolCallPart | undefined {
  for (const t of section.turns) {
    for (const m of t.messages) {
      for (const p of m.parts) {
        if (p.type === "tool_call" && p.toolCallId === toolCallId) return p;
      }
    }
  }
  return undefined;
}

/**
 * Apply a single event to the reducer state (mutates in place).
 * Order of events is authoritative — callers must feed events in the
 * same order they were produced. Safe to call across multiple sources
 * as long as the sequencing matches JSONL order.
 */
export function applyEvent(state: ReducerState, ev: RawEvent): void {
  const nodeId = ev.node_id ?? null;
  const data = ev.data ?? {};

  switch (ev.type) {
    // ----- Node lifecycle: drive section.status -----
    case "node.started":
      if (nodeId) {
        const s = sectionFor(state, nodeId);
        s.status = "running";
        // Project node.started.data onto the section for introspection.
        // All fields optional: non-LLM handlers emit only node_type.
        const nt = data["node_type"];
        if (typeof nt === "string") s.nodeType = nt;
        const pt = data["prompt_template"];
        if (typeof pt === "string") s.promptTemplate = pt;
        const model = data["model"];
        if (typeof model === "string") s.model = model;
        const provider = data["provider"];
        if (typeof provider === "string") s.provider = provider;
        const threadId = data["thread_id"];
        if (typeof threadId === "string") s.threadId = threadId;
        const fidelity = data["fidelity"];
        if (typeof fidelity === "string") s.fidelity = fidelity;
        const allow = data["allowed_tools"];
        if (Array.isArray(allow)) s.allowedTools = allow as string[];
        const deny = data["denied_tools"];
        if (Array.isArray(deny)) s.deniedTools = deny as string[];
        const ctxFiles = data["context_files"];
        if (Array.isArray(ctxFiles)) s.contextFiles = ctxFiles as string[];
        const ctxKeys = data["context_keys"];
        if (Array.isArray(ctxKeys)) s.contextKeys = ctxKeys as string[];
        const nos = data["node_outputs_in_scope"];
        if (Array.isArray(nos)) s.nodeOutputsInScope = nos as string[];
        state.activeNodeId = nodeId;
        state.activeTurn = null;
        state.activeMessage = null;
      }
      break;
    case "node.completed":
      if (nodeId) {
        const s = sectionFor(state, nodeId);
        const outcome = (data["outcome"] as string | undefined) ?? "pass";
        s.status = outcome === "fail" ? "failed" : "completed";
      }
      break;
    case "node.failed":
      if (nodeId) sectionFor(state, nodeId).status = "failed";
      break;
    case "node.retrying":
      if (nodeId) sectionFor(state, nodeId).status = "retrying";
      break;
    case "node.skipped":
      if (nodeId) sectionFor(state, nodeId).status = "skipped";
      break;

    // ----- Agent / turn / message -----
    case "agent.turn_start":
      if (nodeId) {
        state.activeNodeId = nodeId;
        state.activeTurn = openTurn(state, nodeId, ev.session_id ?? null);
        state.activeMessage = null;
      }
      break;
    case "agent.turn_end":
      // Flush any lingering streaming flags; close out the turn.
      if (state.activeMessage) flushStreamingInMessage(state.activeMessage);
      state.activeMessage = null;
      state.activeTurn = null;
      break;
    case "agent.message_start": {
      const role = ((data["role"] as string | undefined) ?? "assistant") as Message["role"];
      state.activeMessage = openMessage(state, role);
      break;
    }
    case "agent.message_end":
      if (state.activeMessage) flushStreamingInMessage(state.activeMessage);
      state.activeMessage = null;
      break;

    // ----- LLM deltas -----
    case "llm.start":
      // Enriched by PiCodergenBackend before each call: resolved prompt +
      // system prompt + model. Attach to the section so the UI can show
      // exactly what the agent was asked (template + substitution result).
      // For loop nodes this fires once per iteration — last write wins,
      // which matches "show what the agent was most recently asked".
      if (state.activeNodeId) {
        const s = sectionFor(state, state.activeNodeId);
        const prompt = data["prompt"];
        if (typeof prompt === "string") s.prompt = prompt;
        const sysp = data["system_prompt"];
        if (typeof sysp === "string") s.systemPrompt = sysp;
        const model = data["model"];
        if (typeof model === "string") s.model = model;
        const provider = data["provider"];
        if (typeof provider === "string") s.provider = provider;
        const threadId = data["thread_id"];
        if (typeof threadId === "string") s.threadId = threadId;
      }
      if (state.activeMessage) {
        const modelId = data["model"] as string | undefined;
        if (modelId) state.activeMessage.modelId = modelId;
      }
      break;
    case "llm.text_delta": {
      const delta = (data["delta"] as string | undefined) ?? "";
      if (delta) appendTextDelta(state, delta);
      break;
    }
    case "llm.thinking_delta": {
      const delta = (data["delta"] as string | undefined) ?? "";
      if (delta) appendReasoningDelta(state, delta);
      break;
    }
    case "llm.toolcall_delta": {
      const delta = (data["delta"] as string | undefined) ?? "";
      const contentIndex = (data["content_index"] as number | undefined) ?? 0;
      appendToolcallDelta(state, contentIndex, delta);
      break;
    }
    case "llm.done":
      if (state.activeMessage) flushStreamingInMessage(state.activeMessage);
      break;

    // ----- Tool execution -----
    case "tool.execution_start": {
      if (!nodeId) break;
      const section = sectionFor(state, nodeId);
      const toolCallId = String(data["tool_call_id"] ?? "");
      const toolName = String(data["tool_name"] ?? "");
      const args = data["args"] ?? null;
      // Prefer binding to an unresolved placeholder in the active turn;
      // fall back to appending a new part on the active message (replay
      // of a JSONL without deltas).
      const turn = state.activeTurn ?? section.turns[section.turns.length - 1];
      let slot: ToolCallPart | undefined = turn ? findUnboundToolCallInTurn(turn) : undefined;
      if (!slot) {
        if (!state.activeMessage) state.activeMessage = openMessage(state, "assistant");
        slot = {
          type: "tool_call",
          toolCallId: "",
          toolName: "",
          input: undefined,
          state: "input-streaming",
        };
        state.activeMessage.parts.push(slot);
      }
      slot.toolCallId = toolCallId;
      slot.toolName = toolName;
      slot.input = args;
      slot.state = "input-available";
      break;
    }
    case "tool.execution_end": {
      if (!nodeId) break;
      const section = sectionFor(state, nodeId);
      const toolCallId = String(data["tool_call_id"] ?? "");
      const isError = Boolean(data["is_error"]);
      const result = data["result"];
      const slot = findToolCallByIdInSection(section, toolCallId);
      if (!slot) break;
      if (isError) {
        slot.state = "output-error";
        slot.errorText = stringifyToolError(result, data["err"]);
      } else {
        slot.state = "output-available";
        slot.output = result;
      }
      break;
    }

    // ----- Steering (legacy) -----
    // Pre-control-channel runs wrote `steering.injected` from a poller
    // inside the backend. New runs use `control.requested(steer)` below,
    // but we keep this branch so replays of older events.jsonl still
    // render correctly.
    case "steering.injected": {
      if (!nodeId) break;
      const message = data["message"];
      if (typeof message !== "string" || message.length === 0) break;
      state.activeNodeId = nodeId;
      if (!state.activeTurn) state.activeTurn = openTurn(state, nodeId, ev.session_id ?? null);
      state.messageCounter += 1;
      const msg: Message = {
        messageId: `${state.activeTurn.turnId}-m${state.messageCounter}`,
        role: "user",
        parts: [{ type: "text", text: message }],
      };
      state.activeTurn.messages.push(msg);
      break;
    }

    // ----- Control channel -----
    // `control.requested(steer)` is the moment a steer message lands on
    // the run's control.jsonl; surface it as a user turn exactly like the
    // legacy `steering.injected` so the UX is unchanged. pause / resume /
    // cancel are run-scoped (no node_id) and surface as lifecycle
    // banners rather than chat bubbles — the conversation reducer skips
    // them and the banner layer (future) reads them directly off the
    // event stream.
    case "control.requested": {
      const command = data["command"];
      if (command !== "steer") break; // pause/resume/cancel — banner layer handles these
      const payload = data["payload"] as { message?: unknown } | undefined;
      const message = payload?.message;
      if (typeof message !== "string" || message.length === 0) break;
      // Control events are run-scoped; attach to the currently-active
      // node/turn so the steer appears inline with the agent's work, not
      // as an orphaned top-level message.
      const targetNodeId = nodeId ?? state.activeNodeId;
      if (!targetNodeId) break;
      state.activeNodeId = targetNodeId;
      if (!state.activeTurn) state.activeTurn = openTurn(state, targetNodeId, ev.session_id ?? null);
      state.messageCounter += 1;
      const msg: Message = {
        messageId: `${state.activeTurn.turnId}-m${state.messageCounter}`,
        role: "user",
        parts: [{ type: "text", text: message }],
      };
      state.activeTurn.messages.push(msg);
      break;
    }

    // ----- Cost attribution -----
    case "cost.recorded": {
      if (!state.activeTurn) break;
      // Attach to the most recent *assistant* message in the current turn.
      for (let i = state.activeTurn.messages.length - 1; i >= 0; i--) {
        const m = state.activeTurn.messages[i];
        if (!m || m.role !== "assistant") continue;
        const cost = data["cost_usd"];
        const inTok = data["input_tokens"];
        const outTok = data["output_tokens"];
        const model = data["model"];
        if (typeof cost === "number") m.costUsd = cost;
        if (typeof inTok === "number") m.inputTokens = inTok;
        if (typeof outTok === "number") m.outputTokens = outTok;
        if (typeof model === "string" && !m.modelId) m.modelId = model;
        break;
      }
      break;
    }

    default:
      // Ignore events that don't affect the conversation projection
      // (run.*, edge.*, interview.*, steering.requested, agent.start,
      // agent.end, checkpoint.*).
      break;
  }
}

/**
 * Batch convenience: fold an entire event array into a fresh conversation
 * tree. Implemented as a thin loop over `applyEvent` so live / replay
 * paths share the exact same semantics — same input, same output, bit
 * for bit. Keep this signature stable; tests depend on it.
 */
export function eventsToConversation(events: readonly RawEvent[]): RunConversation {
  const state = createReducerState();
  for (const ev of events) applyEvent(state, ev);
  return toConversation(state);
}

function stringifyToolError(result: unknown, err: unknown): string {
  if (typeof err === "string" && err.length > 0) return err;
  if (err && typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    try {
      return JSON.stringify(result);
    } catch {
      return "tool error";
    }
  }
  return "tool error";
}

/**
 * Convenience: the swarm tool-name convention is `domain:tool` (e.g.
 * `local:bash`). AI Elements' `ToolHeader` expects `type="tool-<name>"`
 * and its derivation splits on `-`, so `:` must be rewritten. Used by
 * `RunConversation` but exported for tests.
 */
export function toolTypeFromName(toolName: string): `tool-${string}` {
  const safe = toolName.replace(/[^a-zA-Z0-9_]/g, "_");
  return `tool-${safe}` as `tool-${string}`;
}
