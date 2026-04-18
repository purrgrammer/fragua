// Runtime validator smoke tests — envelope-level first (must always hold),
// payload-level opt-in second (only when consumers explicitly ask). The
// goal is a sharp signal when JSONL drift happens while keeping the
// default permissive so old fixtures still replay.

import { describe, expect, test } from "bun:test";
import { CURRENT_EVENT_SCHEMA_VERSION, validateEvent, validateEventStream } from "../src/index.ts";

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "r1",
    type: "node.started",
    timestamp: "2026-04-18T00:00:00.000Z",
    workflow_sha: "deadbeef",
    data: {},
    ...overrides,
  };
}

describe("validateEvent — envelope", () => {
  test("accepts a minimal valid envelope", () => {
    const res = validateEvent(envelope());
    expect(res.ok).toBe(true);
  });

  test("accepts a schema_version of 1 (current)", () => {
    const res = validateEvent(envelope({ schema_version: CURRENT_EVENT_SCHEMA_VERSION }));
    expect(res.ok).toBe(true);
  });

  test("accepts envelopes without schema_version (pre-versioned JSONL)", () => {
    // Legacy runs omit the field entirely. Validator must still accept
    // them so existing .swarm/runs/ fixtures stay replayable.
    const res = validateEvent(envelope());
    expect(res.ok).toBe(true);
  });

  test("rejects when run_id is missing", () => {
    const bad = envelope();
    delete bad["run_id"];
    const res = validateEvent(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join("\n")).toContain("run_id");
  });

  test("rejects when type is the wrong kind", () => {
    const res = validateEvent(envelope({ type: 123 }));
    expect(res.ok).toBe(false);
  });

  test("rejects when schema_version is zero (minimum: 1)", () => {
    const res = validateEvent(envelope({ schema_version: 0 }));
    expect(res.ok).toBe(false);
  });
});

describe("validateEvent — payload (opt-in)", () => {
  test("llm.start payload with Wave-1 fields parses", () => {
    const ev = envelope({
      type: "llm.start",
      schema_version: 1,
      data: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        prompt: "hi",
        system_prompt: "you are helpful",
        thread_id: "dev",
        iteration: { n: 1, max: 3 },
        settings: { reasoning_effort: "high" },
        context_files: [{ path: "AGENTS.md", sha256: "a".repeat(64), bytes: 10, truncated: false, status: "ok" }],
        budget: { cumulative_cost_usd: 0, cumulative_tokens: 0, max_cost_usd: 0.5 },
      },
    });
    const res = validateEvent(ev, { checkPayload: true });
    expect(res.ok).toBe(true);
  });

  test("llm.start payload with wrong type on a captured field fails payload check", () => {
    const ev = envelope({
      type: "llm.start",
      data: { prompt: 42 /* should be string */ },
    });
    // Envelope-only check: tolerant.
    expect(validateEvent(ev).ok).toBe(true);
    // Payload check: catches the drift.
    const res = validateEvent(ev, { checkPayload: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join("\n")).toContain("data/prompt");
  });

  test("event types without a registered payload schema pass through", () => {
    const ev = envelope({ type: "edge.selected", data: { from: "a", to: "b", rule: "lexical" } });
    const res = validateEvent(ev, { checkPayload: true });
    expect(res.ok).toBe(true);
  });
});

describe("validateEventStream", () => {
  test("empty stream is ok", () => {
    expect(validateEventStream([])).toEqual({ ok: true });
  });

  test("stops at the first malformed event and reports its index", () => {
    const events: unknown[] = [envelope(), envelope({ run_id: undefined }), envelope()];
    const res = validateEventStream(events);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.index).toBe(1);
      expect(res.errors.join("\n")).toContain("run_id");
    }
  });
});
