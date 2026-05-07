// Bridge coverage for the *_end events that mark content-block
// boundaries in pi-ai's stream. Captured for partial-turn recovery on
// resume. Payloads stay minimal (just content_index); the assembled
// content is reconstructable from the deltas already in the event log.

import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { bridgeAgentEvent } from "../src/event-bridge.ts";

// Build a message_update wrapper around an inner stream event. The
// outer envelope and the embedded `partial: AssistantMessage` are
// required by the type but unused by the bridge for these cases —
// stubs through `unknown` keep the test focused on the bridge logic.
function streamEvent(inner: { type: string; contentIndex: number }): AgentEvent {
  return {
    type: "message_update",
    message: {} as never,
    assistantMessageEvent: { ...inner, partial: {} as never } as never,
  } as unknown as AgentEvent;
}

describe("event-bridge — *_end content-block markers", () => {
  test("text_end → llm.text_end with content_index only", () => {
    const out = bridgeAgentEvent(streamEvent({ type: "text_end", contentIndex: 0 }));
    expect(out).toEqual({ type: "llm.text_end", data: { content_index: 0 } });
  });

  test("thinking_end → llm.thinking_end with content_index only", () => {
    const out = bridgeAgentEvent(streamEvent({ type: "thinking_end", contentIndex: 1 }));
    expect(out).toEqual({ type: "llm.thinking_end", data: { content_index: 1 } });
  });

  test("toolcall_end → llm.toolcall_end with content_index only", () => {
    const out = bridgeAgentEvent(streamEvent({ type: "toolcall_end", contentIndex: 2 }));
    expect(out).toEqual({ type: "llm.toolcall_end", data: { content_index: 2 } });
  });

  test("text_delta still bridges (regression check on the delta path)", () => {
    const out = bridgeAgentEvent({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: {} as never } as never,
    } as unknown as AgentEvent);
    expect(out).toEqual({ type: "llm.text_delta", data: { delta: "hi", content_index: 0 } });
  });
});
