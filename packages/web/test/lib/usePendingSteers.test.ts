// usePendingSteers — unit tests.
//
// The hook is a pure state container + a reconciliation effect keyed on
// a caller-supplied events array. We drive it via `renderHook` and
// rerender with updated props to simulate the event stream growing.

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { type ReconcileEvent, usePendingSteers } from "../../src/lib/usePendingSteers.ts";
import { useDom } from "../setup.ts";

function controlRequested(id: string): ReconcileEvent {
  return { type: "control.requested", data: { id, command: "steer", payload: { message: "x" } } };
}

function steeringInjected(message: string): ReconcileEvent {
  return { type: "steering.injected", data: { message } };
}

describe("usePendingSteers", () => {
  useDom();
  afterEach(() => cleanup());

  it("enqueue appends an entry in pending state", () => {
    const { result } = renderHook(({ events }) => usePendingSteers(events), {
      initialProps: { events: [] as ReconcileEvent[] },
    });

    act(() => {
      result.current.enqueue("req-1", "hello");
    });
    act(() => {
      result.current.enqueue("req-2", "world");
    });

    expect(result.current.pending).toEqual([
      { id: "req-1", message: "hello", state: "pending" },
      { id: "req-2", message: "world", state: "pending" },
    ]);
  });

  it("drops a pending entry when a matching control.requested(steer) appears", () => {
    const { result, rerender } = renderHook(({ events }) => usePendingSteers(events), {
      initialProps: { events: [] as ReconcileEvent[] },
    });

    act(() => {
      result.current.enqueue("req-1", "hello");
      result.current.enqueue("req-2", "world");
    });

    rerender({ events: [controlRequested("req-1")] });

    expect(result.current.pending).toEqual([{ id: "req-2", message: "world", state: "pending" }]);
  });

  it("legacy: steering.injected clears a pending entry matching by message text", () => {
    const { result, rerender } = renderHook(({ events }) => usePendingSteers(events), {
      initialProps: { events: [] as ReconcileEvent[] },
    });

    act(() => {
      result.current.enqueue("local-abc", "please refocus on step 3");
    });

    rerender({ events: [steeringInjected("please refocus on step 3")] });

    expect(result.current.pending).toEqual([]);
  });

  it("markFailed flips state and entry survives later matching events", () => {
    const { result, rerender } = renderHook(({ events }) => usePendingSteers(events), {
      initialProps: { events: [] as ReconcileEvent[] },
    });

    act(() => {
      result.current.enqueue("req-1", "hello");
    });
    act(() => {
      result.current.markFailed("req-1", "network down");
    });

    expect(result.current.pending).toEqual([{ id: "req-1", message: "hello", state: "failed", error: "network down" }]);

    // A subsequent matching event must NOT auto-remove a failed entry —
    // the user decides when to retry / dismiss.
    rerender({ events: [controlRequested("req-1")] });

    expect(result.current.pending).toEqual([{ id: "req-1", message: "hello", state: "failed", error: "network down" }]);
  });

  it("remove drops an entry regardless of state", () => {
    const { result } = renderHook(({ events }) => usePendingSteers(events), {
      initialProps: { events: [] as ReconcileEvent[] },
    });

    act(() => {
      result.current.enqueue("req-1", "a");
      result.current.enqueue("req-2", "b");
      result.current.markFailed("req-2", "boom");
    });

    act(() => {
      result.current.remove("req-1");
    });
    expect(result.current.pending.map((p) => p.id)).toEqual(["req-2"]);

    act(() => {
      result.current.remove("req-2");
    });
    expect(result.current.pending).toEqual([]);
  });

  it("ignores non-matching events and preserves order", () => {
    const { result, rerender } = renderHook(({ events }) => usePendingSteers(events), {
      initialProps: { events: [] as ReconcileEvent[] },
    });

    act(() => {
      result.current.enqueue("req-1", "a");
      result.current.enqueue("req-2", "b");
      result.current.enqueue("req-3", "c");
    });

    rerender({
      events: [
        // Unrelated events — must not affect the queue.
        { type: "agent.turn_start", data: { node_id: "n1" } },
        { type: "control.requested", data: { id: "req-unknown", command: "pause" } },
        // This should clear only req-2.
        controlRequested("req-2"),
        { type: "llm.text_delta", data: { delta: "hi" } },
      ],
    });

    expect(result.current.pending.map((p) => p.id)).toEqual(["req-1", "req-3"]);
  });
});
