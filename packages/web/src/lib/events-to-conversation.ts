// events-to-conversation — pure reducer folding a swarm event stream into
// a conversation tree for the AI-Elements-driven pipeline view (P5.08).
//
// Design notes:
//
//   - The reducer is pure in the strictest sense: (events, initialState?)
//     → conversation. Same input ⇒ deep-equal output. No Date.now(), no
//     I/O, no randomness. This is what lets tests feed the same events
//     twice and compare with `expect.toEqual`.
//
//   - We scope sections by `node_id`. Events missing `node_id` (pipeline
//     lifecycle: `pipeline.*`, `edge.*`, `interview.*`, `checkpoint.*`,
//     `steering.*`, ...) never produce conversation content — but
//     `node.started|completed|failed|retrying|skipped` still drive the
//     `NodeSection.status` projection.
//
//   - Turns: one `Turn` per `agent.turn_start` within the current node
//     section. A trapezium loop node that runs three iterations emits
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

export type PipelineConversation = NodeSection[];

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
 * Fold `events` into a `PipelineConversation`. Pure — same input produces
 * a deep-equal tree. Input order is authoritative (JSONL is append-only).
 */
export function eventsToConversation(events: readonly RawEvent[]): PipelineConversation {
  // Sections preserve encounter order.
  const sections = new Map<string, NodeSection>();

  // Active-turn / message / node pointers.
  let activeNodeId: string | null = null;
  let activeTurn: Turn | null = null;
  let activeMessage: Message | null = null;
  let turnCounter = 0;
  let messageCounter = 0;

  function sectionFor(nodeId: string): NodeSection {
    let s = sections.get(nodeId);
    if (!s) {
      s = { nodeId, status: "pending", turns: [] };
      sections.set(nodeId, s);
    }
    return s;
  }

  function openTurn(nodeId: string, sessionId: string | null | undefined): Turn {
    turnCounter += 1;
    const turn: Turn = {
      turnId: `${nodeId}-t${turnCounter}`,
      messages: [],
    };
    if (sessionId) turn.sessionId = sessionId;
    sectionFor(nodeId).turns.push(turn);
    return turn;
  }

  function openMessage(role: Message["role"]): Message {
    if (!activeTurn) {
      // Defensive: message_start before any turn_start. Synthesize one.
      if (!activeNodeId) {
        // Hard-drop: no node context at all. Allocate a synthetic
        // "<pre>" bucket rather than crash.
        activeNodeId = "__prelude__";
      }
      activeTurn = openTurn(activeNodeId, null);
    }
    messageCounter += 1;
    const msg: Message = {
      messageId: `${activeTurn.turnId}-m${messageCounter}`,
      role,
      parts: [],
    };
    activeTurn.messages.push(msg);
    return msg;
  }

  function lastPart<T extends Part["type"]>(msg: Message, type: T): Extract<Part, { type: T }> | undefined {
    for (let i = msg.parts.length - 1; i >= 0; i--) {
      const p = msg.parts[i];
      if (p && p.type === type) return p as Extract<Part, { type: T }>;
    }
    return undefined;
  }

  function appendTextDelta(delta: string): void {
    if (!activeMessage) activeMessage = openMessage("assistant");
    const last = lastPart(activeMessage, "text");
    if (last?.streaming) {
      last.text += delta;
      return;
    }
    activeMessage.parts.push({ type: "text", text: delta, streaming: true });
  }

  function appendReasoningDelta(delta: string): void {
    if (!activeMessage) activeMessage = openMessage("assistant");
    // Consolidate: always append to the single reasoning part if it
    // exists, regardless of whether newer parts (text / tool) were
    // interleaved. Matches the "one Reasoning block per Message" rule.
    const existing = lastPart(activeMessage, "reasoning");
    if (existing) {
      existing.text += delta;
      existing.streaming = true;
      return;
    }
    activeMessage.parts.push({ type: "reasoning", text: delta, streaming: true });
  }

  function appendToolcallDelta(contentIndex: number, delta: string): void {
    if (!activeMessage) activeMessage = openMessage("assistant");
    // Look for an existing tool_call part at this content_index in the
    // current message. If present, accumulate; otherwise allocate.
    let slot: ToolCallPart | undefined;
    for (let i = activeMessage.parts.length - 1; i >= 0; i--) {
      const p = activeMessage.parts[i];
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
      activeMessage.parts.push(slot);
    }
    // Stash the raw accumulated JSON on `input` as a string while we
    // stream. Replaced with the parsed `args` on `tool.execution_start`.
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
    // Scan from the most recent message backwards: the next tool
    // execution targets the latest pending placeholder.
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

  // ------------------------------------------------------------------
  // Main fold.
  // ------------------------------------------------------------------
  for (const ev of events) {
    const nodeId = ev.node_id ?? null;
    const data = ev.data ?? {};

    switch (ev.type) {
      // ----- Node lifecycle: drive section.status -----
      case "node.started":
        if (nodeId) {
          const s = sectionFor(nodeId);
          s.status = "running";
          activeNodeId = nodeId;
          activeTurn = null;
          activeMessage = null;
        }
        break;
      case "node.completed":
        if (nodeId) {
          const s = sectionFor(nodeId);
          const outcome = (data["outcome"] as string | undefined) ?? "pass";
          s.status = outcome === "fail" ? "failed" : "completed";
        }
        break;
      case "node.failed":
        if (nodeId) sectionFor(nodeId).status = "failed";
        break;
      case "node.retrying":
        if (nodeId) sectionFor(nodeId).status = "retrying";
        break;
      case "node.skipped":
        if (nodeId) sectionFor(nodeId).status = "skipped";
        break;

      // ----- Agent / turn / message -----
      case "agent.turn_start":
        if (nodeId) {
          activeNodeId = nodeId;
          activeTurn = openTurn(nodeId, ev.session_id ?? null);
          activeMessage = null;
        }
        break;
      case "agent.turn_end":
        // Flush any lingering streaming flags; close out the turn.
        if (activeMessage) flushStreamingInMessage(activeMessage);
        activeMessage = null;
        activeTurn = null;
        break;
      case "agent.message_start": {
        const role = ((data["role"] as string | undefined) ?? "assistant") as Message["role"];
        activeMessage = openMessage(role);
        break;
      }
      case "agent.message_end":
        if (activeMessage) flushStreamingInMessage(activeMessage);
        activeMessage = null;
        break;

      // ----- LLM deltas -----
      case "llm.start":
        if (activeMessage) {
          const modelId = data["model"] as string | undefined;
          if (modelId) activeMessage.modelId = modelId;
        }
        break;
      case "llm.text_delta": {
        const delta = (data["delta"] as string | undefined) ?? "";
        if (delta) appendTextDelta(delta);
        break;
      }
      case "llm.thinking_delta": {
        const delta = (data["delta"] as string | undefined) ?? "";
        if (delta) appendReasoningDelta(delta);
        break;
      }
      case "llm.toolcall_delta": {
        const delta = (data["delta"] as string | undefined) ?? "";
        const contentIndex = (data["content_index"] as number | undefined) ?? 0;
        appendToolcallDelta(contentIndex, delta);
        break;
      }
      case "llm.done":
        if (activeMessage) flushStreamingInMessage(activeMessage);
        break;

      // ----- Tool execution -----
      case "tool.execution_start": {
        if (!nodeId) break;
        const section = sectionFor(nodeId);
        const toolCallId = String(data["tool_call_id"] ?? "");
        const toolName = String(data["tool_name"] ?? "");
        const args = data["args"] ?? null;
        // Prefer binding to an unresolved placeholder in the active
        // turn; fall back to appending a new part on the active
        // message (replay of a JSONL without deltas).
        const turn = activeTurn ?? section.turns[section.turns.length - 1];
        let slot: ToolCallPart | undefined = turn ? findUnboundToolCallInTurn(turn) : undefined;
        if (!slot) {
          if (!activeMessage) activeMessage = openMessage("assistant");
          slot = {
            type: "tool_call",
            toolCallId: "",
            toolName: "",
            input: undefined,
            state: "input-streaming",
          };
          activeMessage.parts.push(slot);
        }
        slot.toolCallId = toolCallId;
        slot.toolName = toolName;
        slot.input = args;
        slot.state = "input-available";
        break;
      }
      case "tool.execution_end": {
        if (!nodeId) break;
        const section = sectionFor(nodeId);
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

      // ----- Cost attribution -----
      case "cost.recorded": {
        if (!activeTurn) break;
        // Attach to the most recent *assistant* message in the current turn.
        for (let i = activeTurn.messages.length - 1; i >= 0; i--) {
          const m = activeTurn.messages[i];
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
        // (pipeline.*, edge.*, interview.*, steering.*, agent.start,
        // agent.end, checkpoint.*).
        break;
    }
  }

  return Array.from(sections.values());
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
 * `PipelineConversation` but exported for tests.
 */
export function toolTypeFromName(toolName: string): `tool-${string}` {
  const safe = toolName.replace(/[^a-zA-Z0-9_]/g, "_");
  return `tool-${safe}` as `tool-${string}`;
}
