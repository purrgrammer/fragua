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
