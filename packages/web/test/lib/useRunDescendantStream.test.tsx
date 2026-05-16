// Tests for useRunDescendantStream. Inject a fake EventSource so the
// per-parent descendant SSE lifecycle can be driven synchronously.
//
// docs/proposals/descendant-event-stream.md.

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useRunDescendantStream } from "../../src/lib/useRunDescendantStream.ts";
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

describe("useRunDescendantStream", () => {
  useDom();
  afterEach(() => {
    cleanup();
    FakeEventSource.instances = [];
  });

  test("bumps descendantToken on each received event", async () => {
    const { result } = renderHook(() =>
      useRunDescendantStream("p", {
        terminal: false,
        eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      }),
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0]!;
    act(() => es._open());

    expect(result.current.descendantToken).toBe("");
    act(() => es._emit(JSON.stringify({ type: "fact.message_appended", runId: "c", seq: 7 }), "1000.c.7"));
    const after1 = result.current.descendantToken;
    expect(after1).not.toBe("");

    act(() => es._emit(JSON.stringify({ type: "fact.message_appended", runId: "c", seq: 8 }), "1000.c.8"));
    expect(result.current.descendantToken).not.toBe(after1);
  });

  test("does not open EventSource when runId is null", () => {
    renderHook(() =>
      useRunDescendantStream(null, {
        terminal: false,
        eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      }),
    );
    expect(FakeEventSource.instances.length).toBe(0);
  });

  test("does not open EventSource when terminal === true", () => {
    renderHook(() =>
      useRunDescendantStream("p", {
        terminal: true,
        eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      }),
    );
    expect(FakeEventSource.instances.length).toBe(0);
  });

  test("does not open EventSource when terminal === undefined (snapshot still loading)", () => {
    renderHook(() =>
      useRunDescendantStream("p", {
        terminal: undefined,
        eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      }),
    );
    expect(FakeEventSource.instances.length).toBe(0);
  });

  test("unmounts cleanly — closes the EventSource", async () => {
    const { unmount } = renderHook(() =>
      useRunDescendantStream("p", {
        terminal: false,
        eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      }),
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0]!;
    expect(es.closed).toBe(false);

    unmount();
    expect(es.closed).toBe(true);
  });

  test("ignores swarm.ping frames (no lastEventId)", async () => {
    const { result } = renderHook(() =>
      useRunDescendantStream("p", {
        terminal: false,
        eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      }),
    );
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0]!;
    act(() => es._open());

    // Server keepalive frame: data has type "swarm.ping" and no id field.
    act(() => es._emit(JSON.stringify({ type: "swarm.ping", ts: 1234 })));
    expect(result.current.descendantToken).toBe("");
  });
});
