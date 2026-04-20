// MessageStore keying — transcript isolation across concurrent runs.
//
// Backends are shared across runs (one per (workflow, node)); the store's
// (runId, threadId) composite key is what keeps two concurrent runs from
// clobbering each other's transcript when they share a `thread_id` like
// `thread_id="dev"`. A single-key-by-threadId store would silently mix
// transcripts — a correctness bug invisible under a serial executor and
// live under a concurrent one.

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, test } from "bun:test";
import { MessageStore } from "../src/message-store.ts";

function msg(role: AgentMessage["role"], text: string): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

describe("MessageStore", () => {
  test("get on empty key returns []", () => {
    const s = new MessageStore();
    expect(s.get("r1", "dev")).toEqual([]);
    expect(s.has("r1", "dev")).toBe(false);
  });

  test("set / get round-trip returns detached copies", () => {
    const s = new MessageStore();
    const input = [msg("user", "hello")];
    s.set("r1", "dev", input);

    const out = s.get("r1", "dev");
    expect(out).toHaveLength(1);

    // Mutating the output does not leak back.
    out.push(msg("assistant", "leaked"));
    expect(s.get("r1", "dev")).toHaveLength(1);

    // Mutating the input also does not leak in (slice on set).
    input.push(msg("assistant", "late"));
    expect(s.get("r1", "dev")).toHaveLength(1);
  });

  test("concurrent runs sharing a threadId do not cross-contaminate", () => {
    const s = new MessageStore();
    s.set("runA", "dev", [msg("user", "A says hi")]);
    s.set("runB", "dev", [msg("user", "B says hi"), msg("assistant", "hi B")]);

    expect(s.get("runA", "dev")).toHaveLength(1);
    expect(s.get("runB", "dev")).toHaveLength(2);

    // Overwriting run A's slot does not touch run B.
    s.set("runA", "dev", [msg("user", "A again"), msg("assistant", "hi A"), msg("user", "A3")]);
    expect(s.get("runA", "dev")).toHaveLength(3);
    expect(s.get("runB", "dev")).toHaveLength(2);
  });

  test("has reports only the specific (runId, threadId) pair", () => {
    const s = new MessageStore();
    s.set("r1", "dev", [msg("user", "x")]);

    expect(s.has("r1", "dev")).toBe(true);
    expect(s.has("r2", "dev")).toBe(false);
    expect(s.has("r1", "main")).toBe(false);
  });

  test("delete only removes the specified pair", () => {
    const s = new MessageStore();
    s.set("r1", "dev", [msg("user", "x")]);
    s.set("r1", "main", [msg("user", "y")]);
    s.set("r2", "dev", [msg("user", "z")]);

    s.delete("r1", "dev");

    expect(s.has("r1", "dev")).toBe(false);
    expect(s.has("r1", "main")).toBe(true);
    expect(s.has("r2", "dev")).toBe(true);
  });

  test("clearRun evicts every thread for a runId and nothing else", () => {
    const s = new MessageStore();
    s.set("r1", "dev", [msg("user", "x")]);
    s.set("r1", "main", [msg("user", "y")]);
    s.set("r1", "scratch", [msg("user", "z")]);
    s.set("r2", "dev", [msg("user", "kept")]);

    s.clearRun("r1");

    expect(s.has("r1", "dev")).toBe(false);
    expect(s.has("r1", "main")).toBe(false);
    expect(s.has("r1", "scratch")).toBe(false);
    expect(s.has("r2", "dev")).toBe(true);
  });

  test("clearRun does not match threadIds that merely start with the runId", () => {
    // The composite key uses a NUL delimiter, so a runId like "r1" must
    // not sweep entries whose runId happens to start with "r1".
    const s = new MessageStore();
    s.set("r1", "dev", [msg("user", "a")]);
    s.set("r10", "dev", [msg("user", "b")]);
    s.set("r1x", "dev", [msg("user", "c")]);

    s.clearRun("r1");

    expect(s.has("r1", "dev")).toBe(false);
    expect(s.has("r10", "dev")).toBe(true);
    expect(s.has("r1x", "dev")).toBe(true);
  });

  test("keys enumerates all (runId, threadId) pairs", () => {
    const s = new MessageStore();
    s.set("r1", "dev", [msg("user", "a")]);
    s.set("r1", "main", [msg("user", "b")]);
    s.set("r2", "dev", [msg("user", "c")]);

    const keys = s.keys().map(({ runId, threadId }) => `${runId}/${threadId}`).sort();
    expect(keys).toEqual(["r1/dev", "r1/main", "r2/dev"]);
  });

  test("serialise / hydrate round-trips the composite keys", () => {
    const s = new MessageStore();
    s.set("r1", "dev", [msg("user", "a")]);
    s.set("r2", "dev", [msg("user", "b"), msg("assistant", "c")]);

    const snapshot = s.serialise();

    const s2 = new MessageStore();
    s2.hydrate(snapshot);

    expect(s2.get("r1", "dev")).toHaveLength(1);
    expect(s2.get("r2", "dev")).toHaveLength(2);
    expect(s2.has("r1", "other")).toBe(false);
  });

  test("clear wipes everything", () => {
    const s = new MessageStore();
    s.set("r1", "dev", [msg("user", "a")]);
    s.set("r2", "dev", [msg("user", "b")]);

    s.clear();

    expect(s.has("r1", "dev")).toBe(false);
    expect(s.has("r2", "dev")).toBe(false);
    expect(s.keys()).toEqual([]);
  });
});
