// Tests for useSSE. We inject a fake EventSource so the hook's lifecycle
// can be driven synchronously (no real network, no timers).
//
// Coverage:
//   - Initial status is "connecting", then "open" on the open event.
//   - Events accumulate in order.
//   - Unmount calls `close()` on the EventSource and transitions to "closed".

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useSSE } from "../../src/lib/useSSE.ts";
import { useDom } from "../setup.ts";

// Minimal EventSource fake. Only implements what the hook touches.
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

  // Test helpers.
  _open(): void {
    this.readyState = 1;
    for (const l of this.listeners.get("open") ?? []) l(new Event("open"));
  }
  _emit(type: string, data: string, id?: string): void {
    const ev = new MessageEvent(type, { data, lastEventId: id ?? "" });
    for (const l of this.listeners.get(type) ?? []) l(ev as unknown as Event);
  }
  _error(): void {
    for (const l of this.listeners.get("error") ?? []) l(new Event("error"));
  }
}

describe("useSSE", () => {
  useDom();
  afterEach(() => {
    cleanup();
    FakeEventSource.instances = [];
  });

  it("transitions connecting → open and accumulates events", async () => {
    const { result } = renderHook(() =>
      useSSE("/api/pipelines/r1/events", { eventSourceImpl: FakeEventSource as unknown as typeof EventSource }),
    );

    // Effect runs on first render; the fake should exist.
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(1);
    });
    const es = FakeEventSource.instances[0];
    expect(es).toBeTruthy();
    if (!es) return;

    expect(result.current.status).toBe("connecting");

    act(() => {
      es._open();
    });
    await waitFor(() => {
      expect(result.current.status).toBe("open");
    });

    act(() => {
      es._emit("node.started", '{"nodeId":"a"}', "1");
      es._emit("node.completed", '{"nodeId":"a"}', "2");
    });
    await waitFor(() => {
      expect(result.current.events.length).toBe(2);
    });
    expect(result.current.events[0]?.type).toBe("node.started");
    expect(result.current.events[0]?.id).toBe("1");
    expect(result.current.events[1]?.type).toBe("node.completed");
  });

  it("closes the EventSource on unmount", async () => {
    const { unmount } = renderHook(() =>
      useSSE("/api/pipelines/r1/events", { eventSourceImpl: FakeEventSource as unknown as typeof EventSource }),
    );
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(1);
    });
    const es = FakeEventSource.instances[0];
    expect(es?.closed).toBe(false);

    unmount();
    expect(es?.closed).toBe(true);
  });

  it("skips subscribing when url is null", () => {
    const { result } = renderHook(() =>
      useSSE(null, { eventSourceImpl: FakeEventSource as unknown as typeof EventSource }),
    );
    expect(FakeEventSource.instances.length).toBe(0);
    expect(result.current.status).toBe("closed");
  });

  it("honours the filter option", async () => {
    const { result } = renderHook(() =>
      useSSE("/api/pipelines/r1/events", {
        eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
        filter: (t) => t.startsWith("node."),
      }),
    );
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(1);
    });
    const es = FakeEventSource.instances[0];
    if (!es) return;
    act(() => {
      es._emit("node.started", "{}", "1");
      es._emit("pipeline.started", "{}", "2");
      es._emit("node.completed", "{}", "3");
    });
    await waitFor(() => {
      expect(result.current.events.length).toBe(2);
    });
    const types = result.current.events.map((e) => e.type);
    expect(types).toEqual(["node.started", "node.completed"]);
  });
});
