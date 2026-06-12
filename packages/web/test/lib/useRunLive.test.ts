// Behavioural tests for useRunLive's bootstrap-fetch lifecycle.
//
// The hook keys its effect on `(runId, terminal, sinceSeq)`. Until both
// `terminal` and `sinceSeq` settle from `undefined` to a real value
// (as the run-detail snapshot resolves), the effect is going to run
// twice anyway — once on mount, again when the snapshot lands. Issuing
// /messages on the first run was wasted work that showed up as 2-3
// extra requests on every conversation page mount (worse under React
// 18 strict-mode dev double-invoke). The hook now defers the bootstrap
// fetch until `terminal` is a boolean.

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useRunLive } from "../../src/lib/useRunLive.ts";
import { installFetchMock } from "../helpers/with-query-client.tsx";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState = 0;
  closed = false;
  private listeners = new Map<string, Set<EventListener>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  _open(): void {
    this.readyState = 1;
    for (const l of this.listeners.get("open") ?? []) l(new Event("open"));
  }

  _emit(data: string, id?: string): void {
    const ev = new MessageEvent("message", { data, lastEventId: id ?? "" });
    for (const l of this.listeners.get("message") ?? []) l(ev as unknown as Event);
  }
}

describe("useRunLive — bootstrap fetch is gated on a settled snapshot", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not fetch /messages while terminal is undefined", async () => {
    const mock = installFetchMock({
      "/api/runs/r1/messages": () =>
        new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    });
    try {
      renderHook(() => useRunLive("r1", { terminal: undefined }));
      // Allow any pending microtasks / effects to settle.
      await new Promise((r) => setTimeout(r, 20));
      const messageCalls = mock.calls.filter((c) => c.url.includes("/messages"));
      expect(messageCalls.length).toBe(0);
    } finally {
      mock.restore();
    }
  });

  it("fetches /messages exactly once after terminal resolves to a boolean", async () => {
    const mock = installFetchMock({
      "/api/runs/r1/messages": () =>
        new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    });
    try {
      // Mount with a settled `terminal=true` (replay path: completed run).
      renderHook(() => useRunLive("r1", { terminal: true, sinceSeq: 42 }));
      await waitFor(() => {
        expect(mock.calls.filter((c) => c.url.includes("/messages")).length).toBe(1);
      });
      // Stay quiet after the bootstrap; nothing else should fire.
      await new Promise((r) => setTimeout(r, 30));
      const messageCalls = mock.calls.filter((c) => c.url.includes("/messages"));
      expect(messageCalls.length).toBe(1);
    } finally {
      mock.restore();
    }
  });

  it("settles to one /messages fetch when terminal flips undefined → false", async () => {
    // Simulates the conversation-page mount: snapshot loading at first
    // (terminal=undefined), then resolving to a non-terminal status.
    const mock = installFetchMock({
      "/api/runs/r1/messages": () =>
        new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    });
    try {
      const { rerender } = renderHook(
        ({ terminal }: { terminal: boolean | undefined }) => useRunLive("r1", { terminal }),
        {
          initialProps: { terminal: undefined as boolean | undefined },
        },
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(mock.calls.filter((c) => c.url.includes("/messages")).length).toBe(0);

      rerender({ terminal: false });
      await waitFor(() => {
        expect(mock.calls.filter((c) => c.url.includes("/messages")).length).toBe(1);
      });
    } finally {
      mock.restore();
    }
  });

  it("tool_node row arriving via refetch clears the live tool stream — fact.node_completed alone does not", async () => {
    // Lifecycle we lock here:
    //   1. tool.output_chunk lands → toolStreams gains an entry, RunConversation
    //      shows a live Terminal.
    //   2. fact.node_completed lands → toolStreams stays (the persisted
    //      Terminal card hasn't loaded yet — clearing now would leave a
    //      blank gap until the next refetch).
    //   3. fact.message_appended lands → triggers messages refetch.
    //   4. Refetch returns a tool_node row → toolStreams entry drops in
    //      the same React update as the persisted row appends, so the
    //      swap is atomic for the renderer.
    let messagesCall = 0;
    const toolNodeRow = {
      ordinal: 1,
      nodeId: "find_pr",
      iteration: 0,
      content: {
        role: "tool_node",
        command: "echo hi",
        cwd: "/tmp",
        exitCode: 0,
        durationMs: 5,
        stdout: "hi\n",
        stderr: "",
        outputArtifactKey: "find_pr:stdout",
        timestamp: 0,
      },
    };
    const mock = installFetchMock({}, ({ url }) => {
      if (url.includes("/messages")) {
        messagesCall++;
        // Bootstrap returns empty; first refetch returns the persisted tool_node row.
        const body = messagesCall === 1 ? [] : [toolNodeRow];
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    try {
      FakeEventSource.instances = [];
      const { result } = renderHook(() =>
        useRunLive("r1", {
          terminal: false,
          sinceSeq: 0,
          eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
        }),
      );

      await waitFor(() => {
        expect(FakeEventSource.instances.length).toBe(1);
      });
      const es = FakeEventSource.instances[0]!;
      act(() => es._open());

      // Bootstrap /messages call landed.
      await waitFor(() => {
        expect(messagesCall).toBe(1);
      });

      // 1) Live stream chunk arrives.
      act(() => {
        es._emit(
          JSON.stringify({
            type: "tool.output_chunk",
            payload: { nodeId: "find_pr", kind: "stdout", delta: "hi\n", content_index: 0 },
          }),
          "1",
        );
      });
      await waitFor(() => {
        expect(result.current.toolStreams.has("find_pr")).toBe(true);
      });

      // 2) Node completion alone must NOT clear the live stream.
      act(() => {
        es._emit(
          JSON.stringify({
            type: "fact.node_completed",
            payload: { nodeId: "find_pr", iteration: 0 },
          }),
          "2",
        );
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(result.current.toolStreams.has("find_pr")).toBe(true);

      // 3) message_appended triggers a refetch (coalesced 30ms in the hook).
      act(() => {
        es._emit(
          JSON.stringify({
            type: "fact.message_appended",
            payload: { ordinal: 1, role: "tool_node", nodeId: "find_pr", iteration: 0 },
          }),
          "3",
        );
      });

      // 4) Once the persisted row lands, the live stream entry drops.
      await waitFor(() => {
        expect(result.current.messages.some((m) => m.content.role === "tool_node")).toBe(true);
        expect(result.current.toolStreams.has("find_pr")).toBe(false);
      });
    } finally {
      mock.restore();
    }
  });

  it("fact.message_appended for an assistant row clears the streaming buffer immediately (no duplicate toolCall card)", async () => {
    // The duplicate-render bug: between `fact.message_appended` (role=
    // assistant, persisted row lands) and `agent.message_end` (streaming
    // buffer cleared) the rich persisted toolCall card AND the streaming-
    // buffer raw-JSON pending card both render. Closing the gap on
    // fact.message_appended eliminates the window.
    const mock = installFetchMock({
      "/api/runs/r1/messages": () =>
        new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    });
    try {
      FakeEventSource.instances = [];
      const { result } = renderHook(() =>
        useRunLive("r1", {
          terminal: false,
          sinceSeq: 0,
          eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
        }),
      );

      await waitFor(() => {
        expect(FakeEventSource.instances.length).toBe(1);
      });
      const es = FakeEventSource.instances[0]!;
      act(() => es._open());

      // Open the streaming buffer for the assistant turn.
      act(() => {
        es._emit(
          JSON.stringify({
            type: "agent.message_start",
            payload: { nodeId: "fix", role: "assistant" },
          }),
          "1",
        );
      });
      // A toolcall_delta populates the streaming buffer with raw args.
      act(() => {
        es._emit(
          JSON.stringify({
            type: "llm.toolcall_delta",
            payload: { nodeId: "fix", content_index: 0, delta: '{"command":"bun run ci"}' },
          }),
          "2",
        );
      });
      await waitFor(() => {
        expect(result.current.streaming?.nodeId).toBe("fix");
        expect(result.current.streaming?.blocks.length).toBeGreaterThan(0);
      });

      // fact.message_appended for assistant lands → streaming buffer
      // clears WITHOUT needing to wait for agent.message_end.
      act(() => {
        es._emit(
          JSON.stringify({
            type: "fact.message_appended",
            payload: { ordinal: 1, role: "assistant", nodeId: "fix", iteration: 0 },
          }),
          "3",
        );
      });
      await waitFor(() => {
        expect(result.current.streaming).toBe(null);
      });
    } finally {
      mock.restore();
    }
  });

  it("fact.message_appended for an UNRELATED nodeId leaves the streaming buffer alone", async () => {
    // Defensive: an assistant row may be appended for a different nodeId
    // mid-stream. The clear must be scoped — clobbering the active buffer
    // would drop in-flight deltas.
    const mock = installFetchMock({
      "/api/runs/r1/messages": () =>
        new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    });
    try {
      FakeEventSource.instances = [];
      const { result } = renderHook(() =>
        useRunLive("r1", {
          terminal: false,
          sinceSeq: 0,
          eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
        }),
      );
      await waitFor(() => {
        expect(FakeEventSource.instances.length).toBe(1);
      });
      const es = FakeEventSource.instances[0]!;
      act(() => es._open());

      act(() => {
        es._emit(
          JSON.stringify({
            type: "agent.message_start",
            payload: { nodeId: "fix", role: "assistant" },
          }),
          "1",
        );
        es._emit(
          JSON.stringify({
            type: "llm.text_delta",
            payload: { nodeId: "fix", content_index: 0, delta: "thinking…" },
          }),
          "2",
        );
      });
      await waitFor(() => {
        expect(result.current.streaming?.nodeId).toBe("fix");
      });

      act(() => {
        es._emit(
          JSON.stringify({
            type: "fact.message_appended",
            payload: { ordinal: 1, role: "assistant", nodeId: "implement", iteration: 0 },
          }),
          "3",
        );
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(result.current.streaming?.nodeId).toBe("fix");
    } finally {
      mock.restore();
    }
  });

  it("concurrent fan-out branches each get their own streaming buffer (no clobber, no interleave)", async () => {
    // A `type: parallel` fan-out runs K branches at once: their
    // message_start/deltas/message_end frames interleave on the wire. With a
    // single shared buffer, branch B's message_start clobbered branch A's, A's
    // deltas leaked into B's buffer, and one branch's message_end nulled the
    // others mid-stream — the user saw interleaved transcripts and tools stuck
    // "Running". streamingByNode keeps each branch independent.
    const mock = installFetchMock({
      "/api/runs/r1/messages": () =>
        new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    });
    try {
      FakeEventSource.instances = [];
      const { result } = renderHook(() =>
        useRunLive("r1", {
          terminal: false,
          sinceSeq: 0,
          eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
        }),
      );
      await waitFor(() => {
        expect(FakeEventSource.instances.length).toBe(1);
      });
      const es = FakeEventSource.instances[0]!;
      act(() => es._open());

      // Two branches open and stream interleaved.
      act(() => {
        es._emit(
          JSON.stringify({ type: "agent.message_start", payload: { nodeId: "lens_a", role: "assistant" } }),
          "1",
        );
        es._emit(
          JSON.stringify({ type: "agent.message_start", payload: { nodeId: "lens_b", role: "assistant" } }),
          "2",
        );
        es._emit(
          JSON.stringify({ type: "llm.text_delta", payload: { nodeId: "lens_a", content_index: 0, delta: "AAA" } }),
          "3",
        );
        es._emit(
          JSON.stringify({ type: "llm.text_delta", payload: { nodeId: "lens_b", content_index: 0, delta: "BBB" } }),
          "4",
        );
      });

      // Both buffers exist, each with only its OWN text — no cross-contamination.
      await waitFor(() => {
        expect(result.current.streamingByNode.size).toBe(2);
      });
      const a = result.current.streamingByNode.get("lens_a");
      const b = result.current.streamingByNode.get("lens_b");
      expect((a?.blocks[0] as { text: string } | undefined)?.text).toBe("AAA");
      expect((b?.blocks[0] as { text: string } | undefined)?.text).toBe("BBB");

      // lens_a ends → only its buffer clears; lens_b keeps streaming.
      act(() => {
        es._emit(JSON.stringify({ type: "agent.message_end", payload: { nodeId: "lens_a", role: "assistant" } }), "5");
      });
      await waitFor(() => {
        expect(result.current.streamingByNode.has("lens_a")).toBe(false);
      });
      expect(result.current.streamingByNode.get("lens_b")?.nodeId).toBe("lens_b");
    } finally {
      mock.restore();
    }
  });

  it("messagesError: set on initial-fetch failure, cleared on refetch success, set again on refetch failure — keeping stale rows", async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    const row = {
      ordinal: 1,
      nodeId: "fix",
      iteration: 0,
      content: { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 0 },
    };
    // Call 1 (bootstrap): 500. Call 2 (refetch): rows. Call 3 (refetch): 500.
    let call = 0;
    const mock = installFetchMock({}, ({ url }) => {
      if (url.includes("/messages")) {
        call++;
        if (call === 2) {
          return new Response(JSON.stringify([row]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("boom", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    });
    try {
      FakeEventSource.instances = [];
      const { result } = renderHook(() =>
        useRunLive("r1", {
          terminal: false,
          sinceSeq: 0,
          eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
        }),
      );
      await waitFor(() => {
        expect(FakeEventSource.instances.length).toBe(1);
      });
      const es = FakeEventSource.instances[0]!;
      act(() => es._open());

      // Bootstrap failed → error surfaced.
      await waitFor(() => {
        expect(result.current.messagesError).toBe(true);
      });

      // SSE signal triggers a refetch that succeeds → error clears, rows land.
      act(() => {
        es._emit(
          JSON.stringify({
            type: "fact.message_appended",
            payload: { ordinal: 1, role: "assistant", nodeId: "fix", iteration: 0 },
          }),
          "1",
        );
      });
      await waitFor(() => {
        expect(result.current.messagesError).toBe(false);
        expect(result.current.messages.length).toBe(1);
      });

      // Next refetch fails → error sets again, stale rows are NOT wiped.
      act(() => {
        es._emit(
          JSON.stringify({
            type: "fact.message_appended",
            payload: { ordinal: 2, role: "assistant", nodeId: "fix", iteration: 0 },
          }),
          "2",
        );
      });
      await waitFor(() => {
        expect(result.current.messagesError).toBe(true);
      });
      expect(result.current.messages.length).toBe(1);
    } finally {
      mock.restore();
      console.warn = origWarn;
    }
  });
});
