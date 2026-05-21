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
        jitter: 0, // deterministic timing
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
        jitter: 0,
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
        jitter: 0,
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
        jitter: 0,
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

  it("stall watchdog force-reconnects when no message arrives within stallMs", async () => {
    // Half-dead-socket scenario: the browser keeps readyState=1 ("open")
    // and never fires error, but no bytes arrive. The hook arms a timer
    // on `open`/`message`; if it fires before re-arming, we close the
    // dead ES and reconnect — without this, the dashboard stays
    // silently stale until TCP timeout (minutes) or page reload.
    const { result } = renderHook(() =>
      useEventSource("/api/events/stream", () => {}, {
        eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
        reconnectBaseMs: 5,
        jitter: 0,
        stallMs: 30,
      }),
    );
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(1);
    });
    const first = FakeEventSource.instances[0]!;
    act(() => first._open());
    await waitFor(() => {
      expect(result.current.status).toBe("open");
    });
    // Don't emit anything — let the watchdog fire after ~30ms.
    await waitFor(
      () => {
        expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 500 },
    );
    // Watchdog must have closed the first ES (so a future delayed
    // event on the dead connection doesn't interfere with the new one).
    expect(first.closed).toBe(true);
    // New connection has the same URL.
    expect(FakeEventSource.instances[1]?.url).toBe("/api/events/stream");
  });

  it("stall watchdog rearms on every inbound frame (real or ping)", async () => {
    // A flowing stream — even one carrying only server keepalives —
    // must NOT trigger a reconnect. The rearm fires on every
    // `message`, before the consumer's parsing logic runs.
    renderHook(() =>
      useEventSource("/api/events/stream", () => {}, {
        eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
        reconnectBaseMs: 5,
        jitter: 0,
        stallMs: 40,
      }),
    );
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(1);
    });
    const es = FakeEventSource.instances[0]!;
    act(() => es._open());

    // Heartbeat for ~120ms total at 20ms cadence (well under the 40ms
    // stall window). If the rearm path is broken, the watchdog would
    // fire mid-heartbeat and a second instance would appear.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 20));
      act(() => es._emit('{"type":"fragua.ping","ts":1}'));
    }
    expect(FakeEventSource.instances.length).toBe(1);
    expect(es.closed).toBe(false);
  });

  it("changing url during a pending reconnect cancels the queued reconnect", async () => {
    // Permanent-close on URL A schedules a reconnect timer. Before it
    // fires, the consumer rerenders with URL B. The cleanup must clear
    // the pending timer so the new effect doesn't race with a stale
    // reconnect to URL A — the only EventSource instances created
    // after rerender should target URL B.
    const { rerender } = renderHook(
      ({ url }: { url: string }) =>
        useEventSource(url, () => {}, {
          eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
          reconnectBaseMs: 200, // long enough that we can rerender before it fires
          jitter: 0,
        }),
      { initialProps: { url: "/api/runs/a/stream" } },
    );
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(1);
    });
    // Permanent close on URL A — schedules a 200ms reconnect timer.
    act(() => {
      const es = FakeEventSource.instances[0]!;
      es.readyState = 2;
      es._error();
    });
    // Rerender with URL B before the timer fires.
    rerender({ url: "/api/runs/b/stream" });
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(2);
    });
    // Wait past the original 200ms backoff window — no third instance
    // should appear (the URL-A reconnect was cancelled by cleanup).
    await new Promise((r) => setTimeout(r, 300));
    expect(FakeEventSource.instances.length).toBe(2);
    expect(FakeEventSource.instances[1]?.url).toBe("/api/runs/b/stream");
  });

  it("stall watchdog rearms after a forced reconnect succeeds", async () => {
    // Watchdog → reconnect → open → silence → watchdog must fire
    // again on the new instance. Verifies the timer lifecycle survives
    // a full reconnect cycle, not just the initial open.
    renderHook(() =>
      useEventSource("/api/events/stream", () => {}, {
        eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
        reconnectBaseMs: 5,
        jitter: 0,
        stallMs: 30,
      }),
    );
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBe(1);
    });
    act(() => FakeEventSource.instances[0]!._open());
    // First watchdog firing → reconnect.
    await waitFor(
      () => {
        expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 500 },
    );
    // Open the second instance. Watchdog rearms on `open`.
    act(() => FakeEventSource.instances[1]!._open());
    // Second silence → second watchdog firing → third instance.
    await waitFor(
      () => {
        expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(3);
      },
      { timeout: 500 },
    );
    expect(FakeEventSource.instances[1]?.closed).toBe(true);
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
