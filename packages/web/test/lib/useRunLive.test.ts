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

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useRunLive } from "../../src/lib/useRunLive.ts";
import { installFetchMock } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

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
  useDom();
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

  it("subagent.resumed frames do not crash the fold and leave subagentByToolCallId stable", async () => {
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

      // Original subagent.start populates the tool_call_id → subagent_id
      // mapping. The resumed frame that follows must NOT clobber or drop it.
      act(() => {
        es._emit(
          JSON.stringify({
            type: "subagent.start",
            payload: { tool_call_id: "toolu_x", subagent_id: "sid_1" },
          }),
          "10",
        );
      });
      await waitFor(() => {
        expect(result.current.subagentByToolCallId.get("toolu_x")).toBe("sid_1");
      });

      act(() => {
        es._emit(
          JSON.stringify({
            type: "subagent.resumed",
            payload: { subagent_id: "sid_1", reason: "already_completed" },
          }),
          "11",
        );
      });

      // After the resumed frame the mapping is unchanged — no clobber,
      // no drop, no exception.
      expect(result.current.subagentByToolCallId.get("toolu_x")).toBe("sid_1");
    } finally {
      mock.restore();
    }
  });
});
