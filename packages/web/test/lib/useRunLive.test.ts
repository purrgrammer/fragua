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
