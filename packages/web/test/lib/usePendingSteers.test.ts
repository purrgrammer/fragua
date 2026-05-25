// usePendingSteers — unit tests.
//
// The hook is a pure state container + a reconciliation effect keyed on
// the run's messages array. We drive it via `renderHook` and rerender
// with a growing messages array to simulate the conversation arriving.

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { RunMessageRow } from "../../src/lib/api.ts";
import { usePendingSteers } from "../../src/lib/usePendingSteers.ts";
import { useDom } from "../setup.ts";

let nextOrdinal = 1;

function userMsg(text: string): RunMessageRow {
  return {
    ordinal: nextOrdinal++,
    nodeId: null,
    iteration: 0,
    content: { role: "user", content: text, timestamp: 0 },
  };
}

function userMsgParts(text: string): RunMessageRow {
  return {
    ordinal: nextOrdinal++,
    nodeId: null,
    iteration: 0,
    content: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
  };
}

function assistantMsg(text: string): RunMessageRow {
  return {
    ordinal: nextOrdinal++,
    nodeId: null,
    iteration: 0,
    content: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "stub",
      usage: {} as never,
      stopReason: "stop",
      timestamp: 0,
    },
  };
}

describe("usePendingSteers", () => {
  useDom();
  afterEach(() => {
    cleanup();
    nextOrdinal = 1;
  });

  it("enqueue appends an entry in pending state", () => {
    const { result } = renderHook(({ messages }) => usePendingSteers(messages), {
      initialProps: { messages: [] as RunMessageRow[] },
    });

    act(() => {
      result.current.enqueue("local-1", "hello");
    });
    act(() => {
      result.current.enqueue("local-2", "world");
    });

    expect(result.current.pending).toEqual([
      { id: "local-1", message: "hello", state: "pending" },
      { id: "local-2", message: "world", state: "pending" },
    ]);
  });

  it("drops a pending entry when a user-role message with the same text arrives", () => {
    const { result, rerender } = renderHook(({ messages }) => usePendingSteers(messages), {
      initialProps: { messages: [] as RunMessageRow[] },
    });

    act(() => {
      result.current.enqueue("local-1", "please refocus");
      result.current.enqueue("local-2", "stay on tests");
    });

    rerender({ messages: [userMsg("please refocus")] });

    expect(result.current.pending).toEqual([{ id: "local-2", message: "stay on tests", state: "pending" }]);
  });

  it("matches user messages whose content is an array of text parts", () => {
    const { result, rerender } = renderHook(({ messages }) => usePendingSteers(messages), {
      initialProps: { messages: [] as RunMessageRow[] },
    });

    act(() => {
      result.current.enqueue("local-1", "go left");
    });

    rerender({ messages: [userMsgParts("go left")] });

    expect(result.current.pending).toEqual([]);
  });

  it("ignores assistant messages even when their text matches", () => {
    // The agent's own output should never drain a queued steer — only
    // the user-role injection of the steer counts as "applied".
    const { result, rerender } = renderHook(({ messages }) => usePendingSteers(messages), {
      initialProps: { messages: [] as RunMessageRow[] },
    });

    act(() => {
      result.current.enqueue("local-1", "echo this");
    });

    rerender({ messages: [assistantMsg("echo this")] });

    expect(result.current.pending).toEqual([{ id: "local-1", message: "echo this", state: "pending" }]);
  });

  it("markFailed flips state and entry survives later matching messages", () => {
    const { result, rerender } = renderHook(({ messages }) => usePendingSteers(messages), {
      initialProps: { messages: [] as RunMessageRow[] },
    });

    act(() => {
      result.current.enqueue("local-1", "hello");
    });
    act(() => {
      result.current.markFailed("local-1", "network down");
    });

    expect(result.current.pending).toEqual([
      { id: "local-1", message: "hello", state: "failed", error: "network down" },
    ]);

    rerender({ messages: [userMsg("hello")] });

    expect(result.current.pending).toEqual([
      { id: "local-1", message: "hello", state: "failed", error: "network down" },
    ]);
  });

  it("remove drops an entry regardless of state", () => {
    const { result } = renderHook(({ messages }) => usePendingSteers(messages), {
      initialProps: { messages: [] as RunMessageRow[] },
    });

    act(() => {
      result.current.enqueue("local-1", "a");
      result.current.enqueue("local-2", "b");
      result.current.markFailed("local-2", "boom");
    });

    act(() => {
      result.current.remove("local-1");
    });
    expect(result.current.pending.map((p) => p.id)).toEqual(["local-2"]);

    act(() => {
      result.current.remove("local-2");
    });
    expect(result.current.pending).toEqual([]);
  });

  it("preserves order and only drains entries with matching text", () => {
    const { result, rerender } = renderHook(({ messages }) => usePendingSteers(messages), {
      initialProps: { messages: [] as RunMessageRow[] },
    });

    act(() => {
      result.current.enqueue("local-1", "a");
      result.current.enqueue("local-2", "b");
      result.current.enqueue("local-3", "c");
    });

    rerender({ messages: [userMsg("unrelated"), userMsg("b")] });

    expect(result.current.pending.map((p) => p.id)).toEqual(["local-1", "local-3"]);
  });
});
