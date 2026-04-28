// Tests for useEventSource. Inject a fake EventSource so the hook's
// lifecycle can be driven synchronously (no real network, no timers).

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useEventSource } from "../../src/lib/useEventSource.ts";
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
  _error(): void {
    for (const l of this.listeners.get("error") ?? []) l(new Event("error"));
  }
}

describe("useEventSource", () => {
  useDom();
  afterEach(() => {
    cleanup();
    FakeEventSource.instances = [];
  });

  it("transitions connecting → open and forwards every frame to onFrame", async () => {
    const frames: { data: string; id: string }[] = [];
    const onFrame = (ev: MessageEvent): void => {
      frames.push({ data: String(ev.data ?? ""), id: String(ev.lastEventId ?? "") });
    };

    const { result } = renderHook(() =>
      useEventSource("/api/runs/r1/stream", onFrame, {
        eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      }),
    );

    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(1);
    });
    const es = FakeEventSource.instances[0];
    if (!es) return;

    expect(result.current.status).toBe("connecting");

    act(() => es._open());
    await waitFor(() => {
      expect(result.current.status).toBe("open");
    });

    act(() => {
      es._emit('{"type":"node.started","payload":{}}', "1");
      es._emit('{"type":"node.completed","payload":{}}', "2");
    });

    expect(frames).toEqual([
      { data: '{"type":"node.started","payload":{}}', id: "1" },
      { data: '{"type":"node.completed","payload":{}}', id: "2" },
    ]);
  });

  it("calls close() on unmount", async () => {
    const { unmount } = renderHook(() =>
      useEventSource("/api/runs/r1/stream", () => {}, {
        eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      }),
    );
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(1);
    });
    const es = FakeEventSource.instances[0];
    expect(es?.closed).toBe(false);

    unmount();
    expect(es?.closed).toBe(true);
  });

  it("skips subscribing when url is null and reports closed", () => {
    const { result } = renderHook(() =>
      useEventSource(null, () => {}, {
        eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      }),
    );
    expect(FakeEventSource.instances.length).toBe(0);
    expect(result.current.status).toBe("closed");
  });

  it("transitions to error status on connection failure", async () => {
    const { result } = renderHook(() =>
      useEventSource("/api/runs/r1/stream", () => {}, {
        eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      }),
    );
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(1);
    });
    const es = FakeEventSource.instances[0];
    if (!es) return;
    act(() => es._error());
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
  });

  it("auto-reconnects after a permanent close (readyState=2) with backoff", async () => {
    // Permanent-close scenario: dev proxy times out an idle stream, or
    // the server response ends with a non-2xx. The browser does NOT
    // retry — the hook schedules its own reconnect.
    const { result } = renderHook(() =>
      useEventSource("/api/events/stream", () => {}, {
        eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
        reconnectBaseMs: 5, // tiny backoff so the test doesn't sleep
      }),
    );
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(1);
    });
    const first = FakeEventSource.instances[0];
    if (!first) return;

    // Open then permanently close (browser sets readyState=2 then fires error).
    act(() => first._open());
    await waitFor(() => {
      expect(result.current.status).toBe("open");
    });
    act(() => {
      first.readyState = 2;
      first._error();
    });
    await waitFor(() => {
      expect(result.current.status).toBe("closed");
    });

    // Backoff timer fires → a NEW EventSource is created with the same URL.
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(2);
    });
    expect(FakeEventSource.instances[1]?.url).toBe("/api/events/stream");
  });

  it("successful reconnect resets the backoff curve", async () => {
    // After an open, the next permanent close should start the backoff
    // back at attempt 0 — long-running sessions don't accumulate delay.
    const { result } = renderHook(() =>
      useEventSource("/api/events/stream", () => {}, {
        eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
        reconnectBaseMs: 5,
      }),
    );
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(1);
    });
    // Cycle 1: error → reconnect.
    act(() => {
      const es = FakeEventSource.instances[0]!;
      es.readyState = 2;
      es._error();
    });
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(2);
    });
    // Open the second one — this should reset the attempt counter.
    act(() => FakeEventSource.instances[1]?._open());
    await waitFor(() => {
      expect(result.current.status).toBe("open");
    });
    // Cycle 2: error again. The new backoff starts at base (5ms), not
    // base*2 (10ms). We can't observe the exact delay easily, but we
    // CAN observe that it eventually fires within the test's window.
    act(() => {
      const es = FakeEventSource.instances[1]!;
      es.readyState = 2;
      es._error();
    });
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(3);
    });
  });

  it("transient errors (readyState != 2) do NOT reconnect — browser handles those", async () => {
    renderHook(() =>
      useEventSource("/api/events/stream", () => {}, {
        eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
        reconnectBaseMs: 5,
      }),
    );
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(1);
    });
    const first = FakeEventSource.instances[0]!;
    // Transient error: readyState stays at 0 (CONNECTING) — browser is
    // about to retry on its own.
    act(() => {
      first.readyState = 0;
      first._error();
    });
    // Give the (would-be) reconnect timer plenty of time to fire — it
    // shouldn't, because we're not in the permanent-close branch.
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeEventSource.instances.length).toBe(1);
  });

  it("unmount cancels a pending reconnect", async () => {
    const { unmount } = renderHook(() =>
      useEventSource("/api/events/stream", () => {}, {
        eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
        reconnectBaseMs: 50,
      }),
    );
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(1);
    });
    act(() => {
      const es = FakeEventSource.instances[0]!;
      es.readyState = 2;
      es._error();
    });
    // Unmount BEFORE the backoff timer fires.
    unmount();
    await new Promise((r) => setTimeout(r, 80));
    // No second EventSource was created.
    expect(FakeEventSource.instances.length).toBe(1);
  });

  it("changing url tears down the old connection and opens a new one", async () => {
    const { rerender } = renderHook(
      ({ url }: { url: string | null }) =>
        useEventSource(url, () => {}, {
          eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
        }),
      { initialProps: { url: "/api/runs/r1/stream" as string | null } },
    );

    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(1);
    });
    const first = FakeEventSource.instances[0];
    if (!first) return;

    rerender({ url: "/api/runs/r2/stream" });
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(2);
    });
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances[1]?.url).toBe("/api/runs/r2/stream");
  });
});
