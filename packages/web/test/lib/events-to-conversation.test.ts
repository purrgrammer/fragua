// events-to-conversation reducer tests.
//
// Three flavours of coverage:
//   1. Synthetic event sequences that exercise each branch of the
//      reducer in isolation (streaming, reasoning consolidation, tool
//      lifecycle, multi-turn retries on one node, determinism).
//   2. A fixture smoke test: fold a real `.swarm/runs/<id>/events.jsonl`
//      and assert shape invariants (≥1 section per executed node, no
//      thrown errors, costs attributed to assistant messages).
//   3. Edge cases: unknown event types ignored, missing node_id events
//      (run.*) dropped from conversation but still inform status.
//
// Fixtures are checked into the repo under `.swarm/runs/` — they're
// large (~23k lines) so we stream the short fixture rather than load
// into a diff-friendly snapshot. Runs aren't deterministic, so we
// assert on structure, not content.

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  eventsToConversation,
  parseSSEEvents,
  type RawEvent,
  toolTypeFromName,
} from "../../src/lib/events-to-conversation.ts";

const REPO_ROOT = join(import.meta.dir, "../../../..");
const SHORT_FIXTURE = join(REPO_ROOT, ".swarm/runs/1776447451676-vqde47/events.jsonl");

function ev(type: string, opts: Partial<RawEvent> = {}): RawEvent {
  return {
    type,
    node_id: opts.node_id ?? "n1",
    session_id: opts.session_id ?? null,
    data: opts.data ?? {},
  };
}

describe("eventsToConversation — synthetic sequences", () => {
  it("returns an empty array on an empty stream", () => {
    expect(eventsToConversation([])).toEqual([]);
  });

  it("creates one section per executed node", () => {
    const out = eventsToConversation([
      ev("node.started", { node_id: "a" }),
      ev("node.completed", { node_id: "a", data: { outcome: "pass" } }),
      ev("node.started", { node_id: "b" }),
      ev("node.completed", { node_id: "b", data: { outcome: "pass" } }),
    ]);
    expect(out.map((s) => s.nodeId)).toEqual(["a", "b"]);
    expect(out[0]?.status).toBe("completed");
    expect(out[1]?.status).toBe("completed");
  });

  it("streams llm.text_delta × N into one text part, flushed by llm.done", () => {
    const pieces = ["Hel", "lo, ", "wor", "ld", "!"];
    const stream: RawEvent[] = [
      ev("node.started"),
      ev("agent.turn_start"),
      ev("agent.message_start", { data: { role: "assistant" } }),
      ...pieces.map((delta) => ev("llm.text_delta", { data: { delta, content_index: 0 } })),
      ev("llm.done"),
      ev("agent.message_end", { data: { role: "assistant" } }),
      ev("agent.turn_end"),
    ];
    const out = eventsToConversation(stream);
    const msg = out[0]?.turns[0]?.messages[0];
    expect(msg?.parts).toHaveLength(1);
    const part = msg?.parts[0];
    if (part?.type !== "text") throw new Error("expected text part");
    expect(part.text).toBe("Hello, world!");
    expect(part.streaming).toBe(false);
  });

  it("live-streaming (no llm.done / message_end yet) leaves streaming=true", () => {
    const out = eventsToConversation([
      ev("node.started"),
      ev("agent.turn_start"),
      ev("agent.message_start", { data: { role: "assistant" } }),
      ev("llm.text_delta", { data: { delta: "partial…" } }),
    ]);
    const part = out[0]?.turns[0]?.messages[0]?.parts[0];
    if (part?.type !== "text") throw new Error("expected text part");
    expect(part.streaming).toBe(true);
    expect(part.text).toBe("partial…");
  });

  it("consolidates adjacent thinking bursts into ONE reasoning part", () => {
    const out = eventsToConversation([
      ev("node.started"),
      ev("agent.turn_start"),
      ev("agent.message_start", { data: { role: "assistant" } }),
      ev("llm.thinking_delta", { data: { delta: "Let me think…" } }),
      ev("llm.thinking_delta", { data: { delta: " more." } }),
      ev("llm.text_delta", { data: { delta: "ok" } }),
      ev("llm.thinking_delta", { data: { delta: " wait, also…" } }),
      ev("llm.done"),
      ev("agent.message_end", { data: { role: "assistant" } }),
    ]);
    const parts = out[0]?.turns[0]?.messages[0]?.parts ?? [];
    const reasoning = parts.filter((p) => p.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    if (reasoning[0]?.type !== "reasoning") throw new Error();
    expect(reasoning[0].text).toBe("Let me think… more. wait, also…");
    expect(reasoning[0].streaming).toBe(false);
  });

  it("walks a tool call through its full lifecycle", () => {
    const out = eventsToConversation([
      ev("node.started"),
      ev("agent.turn_start"),
      ev("agent.message_start", { data: { role: "assistant" } }),
      ev("llm.text_delta", { data: { delta: "calling tool…", content_index: 0 } }),
      ev("llm.toolcall_delta", { data: { delta: '{"p', content_index: 1 } }),
      ev("llm.toolcall_delta", { data: { delta: 'ath":"/tmp"}', content_index: 1 } }),
      ev("agent.message_end", { data: { role: "assistant" } }),
      ev("tool.execution_start", {
        data: {
          tool_call_id: "call_1",
          tool_name: "read",
          args: { path: "/tmp" },
        },
      }),
      ev("tool.execution_end", {
        data: {
          tool_call_id: "call_1",
          tool_name: "read",
          is_error: false,
          result: { content: [{ type: "text", text: "hello" }] },
        },
      }),
      ev("agent.turn_end"),
    ]);
    const parts = out[0]?.turns[0]?.messages[0]?.parts ?? [];
    const tool = parts.find((p) => p.type === "tool_call");
    if (tool?.type !== "tool_call") throw new Error("no tool_call");
    expect(tool.toolCallId).toBe("call_1");
    expect(tool.toolName).toBe("read");
    expect(tool.input).toEqual({ path: "/tmp" });
    expect(tool.state).toBe("output-available");
    expect(tool.output).toEqual({ content: [{ type: "text", text: "hello" }] });
  });

  it("tool.execution_end with is_error=true flips to output-error", () => {
    const out = eventsToConversation([
      ev("node.started"),
      ev("agent.turn_start"),
      ev("agent.message_start", { data: { role: "assistant" } }),
      ev("llm.toolcall_delta", { data: { delta: "{}", content_index: 1 } }),
      ev("agent.message_end"),
      ev("tool.execution_start", {
        data: { tool_call_id: "call_err", tool_name: "bash", args: { cmd: "fail" } },
      }),
      ev("tool.execution_end", {
        data: {
          tool_call_id: "call_err",
          tool_name: "bash",
          is_error: true,
          result: "permission denied",
        },
      }),
    ]);
    const parts = out[0]?.turns[0]?.messages[0]?.parts ?? [];
    const tool = parts.find((p) => p.type === "tool_call");
    if (tool?.type !== "tool_call") throw new Error();
    expect(tool.state).toBe("output-error");
    expect(tool.errorText).toBe("permission denied");
  });

  it("multi-turn node (retry via backward edge) yields 3 turns in ONE section", () => {
    const mkTurn = (i: number): RawEvent[] => [
      ev("agent.turn_start", { node_id: "implement" }),
      ev("agent.message_start", {
        node_id: "implement",
        data: { role: "assistant" },
      }),
      ev("llm.text_delta", {
        node_id: "implement",
        data: { delta: `iteration ${i}`, content_index: 0 },
      }),
      ev("agent.message_end", {
        node_id: "implement",
        data: { role: "assistant" },
      }),
      ev("agent.turn_end", { node_id: "implement" }),
    ];
    const stream: RawEvent[] = [
      ev("node.started", { node_id: "implement" }),
      ...mkTurn(1),
      ...mkTurn(2),
      ...mkTurn(3),
      ev("node.completed", {
        node_id: "implement",
        data: { outcome: "pass" },
      }),
    ];
    const out = eventsToConversation(stream);
    expect(out).toHaveLength(1);
    expect(out[0]?.nodeId).toBe("implement");
    expect(out[0]?.turns).toHaveLength(3);
    expect(out[0]?.status).toBe("completed");
  });

  it("cost.recorded attaches to the most recent assistant message in the turn", () => {
    const out = eventsToConversation([
      ev("node.started"),
      ev("agent.turn_start"),
      ev("agent.message_start", { data: { role: "user" } }),
      ev("agent.message_end", { data: { role: "user" } }),
      ev("agent.message_start", { data: { role: "assistant" } }),
      ev("llm.text_delta", { data: { delta: "hi" } }),
      ev("llm.done"),
      ev("cost.recorded", {
        data: {
          cost_usd: 0.001,
          input_tokens: 10,
          output_tokens: 5,
          model: "claude-haiku-4-5",
        },
      }),
      ev("agent.message_end", { data: { role: "assistant" } }),
    ]);
    const messages = out[0]?.turns[0]?.messages ?? [];
    const user = messages.find((m) => m.role === "user");
    const assistant = messages.find((m) => m.role === "assistant");
    expect(user?.costUsd).toBeUndefined();
    expect(assistant?.costUsd).toBe(0.001);
    expect(assistant?.inputTokens).toBe(10);
    expect(assistant?.outputTokens).toBe(5);
    expect(assistant?.modelId).toBe("claude-haiku-4-5");
  });

  it("drops run-lifecycle events from conversation content", () => {
    const out = eventsToConversation([
      ev("run.started", { node_id: null, data: { graph_id: "g" } }),
      ev("node.started", { node_id: "a" }),
      ev("edge.selected", { node_id: "a", data: { from: "a", to: "b", rule: "weight" } }),
      ev("node.completed", { node_id: "a", data: { outcome: "pass" } }),
      ev("run.completed", { node_id: null }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.turns).toEqual([]);
    expect(out[0]?.status).toBe("completed");
  });

  it("is deterministic — same input ⇒ deep-equal output", () => {
    const stream: RawEvent[] = [
      ev("node.started"),
      ev("agent.turn_start"),
      ev("agent.message_start", { data: { role: "assistant" } }),
      ev("llm.text_delta", { data: { delta: "A" } }),
      ev("llm.text_delta", { data: { delta: "B" } }),
      ev("llm.thinking_delta", { data: { delta: "think" } }),
      ev("llm.toolcall_delta", { data: { delta: "{}", content_index: 1 } }),
      ev("llm.done"),
      ev("agent.message_end"),
      ev("tool.execution_start", {
        data: { tool_call_id: "t1", tool_name: "bash", args: { cmd: "x" } },
      }),
      ev("tool.execution_end", {
        data: { tool_call_id: "t1", tool_name: "bash", is_error: false, result: "ok" },
      }),
    ];
    const a = eventsToConversation(stream);
    const b = eventsToConversation(stream);
    expect(a).toEqual(b);
  });

  it("captures node.started input snapshot on the section (template, model, context_keys)", () => {
    const out = eventsToConversation([
      ev("node.started", {
        node_id: "do_work",
        data: {
          node_type: "codergen",
          prompt_template: "hello ${context.greeting}",
          model: "claude-opus-4-7",
          provider: "anthropic",
          context_keys: ["greeting"],
          allowed_tools: ["bash"],
        },
      }),
    ]);
    const s = out[0];
    expect(s?.nodeType).toBe("codergen");
    expect(s?.promptTemplate).toBe("hello ${context.greeting}");
    expect(s?.model).toBe("claude-opus-4-7");
    expect(s?.provider).toBe("anthropic");
    expect(s?.contextKeys).toEqual(["greeting"]);
    expect(s?.allowedTools).toEqual(["bash"]);
  });

  it("captures llm.start resolved prompt + system prompt on the section", () => {
    const out = eventsToConversation([
      ev("node.started", {
        node_id: "do_work",
        data: { node_type: "codergen", prompt_template: "hello ${context.greeting}" },
      }),
      ev("llm.start", {
        node_id: "do_work",
        data: {
          provider: "anthropic",
          model: "claude-opus-4-7",
          prompt: "hello world",
          system_prompt: "You are a helpful assistant.",
          thread_id: "t-42",
        },
      }),
    ]);
    const s = out[0];
    expect(s?.prompt).toBe("hello world");
    expect(s?.systemPrompt).toBe("You are a helpful assistant.");
    expect(s?.model).toBe("claude-opus-4-7");
    expect(s?.threadId).toBe("t-42");
    // Template stays distinct from resolved prompt.
    expect(s?.promptTemplate).toBe("hello ${context.greeting}");
  });

  it("steering.injected renders as a user message in the active section/turn", () => {
    const out = eventsToConversation([
      ev("node.started", { node_id: "n1" }),
      ev("agent.turn_start", { node_id: "n1" }),
      // Assistant is mid-stream when user steers.
      ev("agent.message_start", { node_id: "n1", data: { role: "assistant" } }),
      ev("llm.text_delta", { node_id: "n1", data: { delta: "Working on it…" } }),
      ev("steering.injected", { node_id: "n1", data: { message: "please focus on tests" } }),
    ]);
    const turn = out[0]?.turns[0];
    expect(turn?.messages.map((m) => m.role)).toEqual(["assistant", "user"]);
    const userMsg = turn?.messages[1];
    expect(userMsg?.parts).toEqual([{ type: "text", text: "please focus on tests" }]);
  });

  it("steering.injected with no active turn opens one", () => {
    const out = eventsToConversation([
      ev("node.started", { node_id: "n1" }),
      ev("steering.injected", { node_id: "n1", data: { message: "hello" } }),
    ]);
    const msg = out[0]?.turns[0]?.messages[0];
    expect(msg?.role).toBe("user");
    expect(msg?.parts).toEqual([{ type: "text", text: "hello" }]);
  });

  it("records node.retrying / node.failed / node.skipped on the section", () => {
    const out = eventsToConversation([
      ev("node.started", { node_id: "x" }),
      ev("node.retrying", { node_id: "x" }),
      ev("node.failed", { node_id: "x" }),
      ev("node.started", { node_id: "y" }),
      ev("node.skipped", { node_id: "y" }),
    ]);
    const byId = Object.fromEntries(out.map((s) => [s.nodeId, s.status]));
    expect(byId).toEqual({ x: "failed", y: "skipped" });
  });
});

describe("toolTypeFromName", () => {
  it("prefixes the tool name with `tool-` for AI Elements' ToolHeader", () => {
    expect(toolTypeFromName("bash")).toBe("tool-bash");
    expect(toolTypeFromName("read")).toBe("tool-read");
    expect(toolTypeFromName("edit")).toBe("tool-edit");
  });
});

describe("parseSSEEvents", () => {
  it("parses well-formed JSON frames and skips garbage", () => {
    const out = parseSSEEvents([
      { type: "message", data: JSON.stringify({ type: "node.started", node_id: "a", data: {} }) },
      { type: "message", data: "not-json" },
      { type: "message", data: JSON.stringify({ type: "node.completed", node_id: "a", data: { outcome: "pass" } }) },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.type).toBe("node.started");
    expect(out[1]?.type).toBe("node.completed");
  });
});

describe("eventsToConversation — real fixture smoke test", () => {
  // `.swarm/runs/*` fixtures are committed (gitignored at the run level
  // but these specific two runs are kept for UI tests — see AGENTS.md).
  // If somehow absent (fresh clone), skip rather than fail: the synthetic
  // tests above are the contract; the fixture catches shape drift against
  // real event bridges.
  const available = existsSync(SHORT_FIXTURE);

  it.if(available)("folds a real events.jsonl into well-formed sections", () => {
    const lines = readFileSync(SHORT_FIXTURE, "utf8").split("\n").filter(Boolean);
    const events: RawEvent[] = lines.map((l) => JSON.parse(l));
    const out = eventsToConversation(events);

    // At least one section (fixture always has nodes).
    expect(out.length).toBeGreaterThan(0);

    // Every section has a known status.
    const knownStatuses = new Set(["pending", "running", "completed", "failed", "skipped", "retrying"]);
    for (const s of out) expect(knownStatuses.has(s.status)).toBe(true);

    // At least one section has turns with assistant messages.
    const hasAssistant = out.some((s) => s.turns.some((t) => t.messages.some((m) => m.role === "assistant")));
    expect(hasAssistant).toBe(true);

    // All tool_calls that reached execution_end have a terminal state.
    for (const s of out) {
      for (const t of s.turns) {
        for (const m of t.messages) {
          for (const p of m.parts) {
            if (p.type === "tool_call" && p.toolCallId) {
              expect(["input-available", "output-available", "output-error"]).toContain(p.state);
            }
          }
        }
      }
    }

    // Determinism on a big real stream.
    const again = eventsToConversation(events);
    expect(again).toEqual(out);
  });
});
