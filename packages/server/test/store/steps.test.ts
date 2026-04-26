// Unit tests for the eventsToSteps reducer.

import { describe, expect, test } from "bun:test";
import type { StoredEvent } from "@swarm/store";
import { attachStepAggregates, eventsToSteps } from "../../src/store/steps.ts";

function ev(type: string, ts: number, payload: Record<string, unknown>): StoredEvent {
  return { runId: "r", seq: ts, type, writer: "daemon", payload, ts };
}

describe("eventsToSteps", () => {
  test("returns empty array when no llm.start events are present", () => {
    const events = [ev("fact.run_started", 1000, { startNode: "n1" })];
    expect(eventsToSteps(events)).toEqual([]);
  });

  test("one llm.start → one step with envelope fields", () => {
    const events = [
      ev("llm.start", 1_000_000, {
        nodeId: "n1",
        iteration: 0,
        prompt: "Do the thing",
        system_prompt: "You are a helpful assistant",
        provider: "openrouter",
        model: "anthropic/claude-haiku-4.5",
        thread_id: "dev",
        fidelity: "compact",
        allowed_tools: ["local:bash", "local:read_file"],
        denied_tools: [],
        messages: [{ role: "user", content: "hi", timestamp: 0 }],
        context_files: [],
      }),
    ];
    const steps = eventsToSteps(events);
    expect(steps).toHaveLength(1);
    const s = steps[0]!;
    expect(s.stepIdx).toBe(0);
    expect(s.nodeId).toBe("n1");
    expect(s.prompt).toBe("Do the thing");
    expect(s.systemPrompt).toBe("You are a helpful assistant");
    expect(s.provider).toBe("openrouter");
    expect(s.model).toBe("anthropic/claude-haiku-4.5");
    expect(s.threadId).toBe("dev");
    expect(s.fidelity).toBe("compact");
    expect(s.allowedTools).toEqual(["local:bash", "local:read_file"]);
    expect(s.deniedTools).toEqual([]);
    expect(s.messages).toEqual([{ role: "user", content: "hi", timestamp: 0 }]);
    expect(s.startedAt).toBe(new Date(1_000_000).toISOString());
  });

  test("llm.text_delta accumulates into finalText on the current step", () => {
    const events = [
      ev("llm.start", 1000, { nodeId: "n1", prompt: "q" }),
      ev("llm.text_delta", 1100, { nodeId: "n1", delta: "hel" }),
      ev("llm.text_delta", 1200, { nodeId: "n1", delta: "lo, " }),
      ev("llm.text_delta", 1300, { nodeId: "n1", delta: "world" }),
    ];
    const [s] = eventsToSteps(events);
    expect(s!.finalText).toBe("hello, world");
  });

  test("llm.done updates endedAt / durationMs / stopReason but does NOT close the step", () => {
    // Tool-using turns emit multiple message_end events under one
    // llm.start, each producing its own llm.done. The reducer must keep
    // the step open so subsequent events still attribute to it; the LAST
    // llm.done's timestamp wins.
    const events = [
      ev("llm.start", 1_000_000, { nodeId: "n1", prompt: "q" }),
      ev("llm.text_delta", 1_000_500, { nodeId: "n1", delta: "first" }),
      ev("llm.done", 1_001_000, { nodeId: "n1", stop_reason: "tool_use" }),
      // Second message in the same backend.run — must still attach.
      ev("llm.text_delta", 1_002_000, { nodeId: "n1", delta: "-second" }),
      ev("llm.done", 1_003_200, { nodeId: "n1", stop_reason: "end_turn" }),
    ];
    const [s] = eventsToSteps(events);
    expect(s!.finalText).toBe("first-second");
    expect(s!.stopReason).toBe("end_turn");
    expect(s!.durationMs).toBe(3200);
    expect(s!.endedAt).toBe(new Date(1_003_200).toISOString());
  });

  test("cost.recorded is NOT folded into the step (cost comes from SQL aggregates)", () => {
    // Cost / token sums are produced by `IEventStore.getStepAggregates()`
    // and merged via `attachStepAggregates`. eventsToSteps deliberately
    // ignores cost.recorded so there's a single source of truth.
    const events = [
      ev("llm.start", 1000, { nodeId: "n1", prompt: "q" }),
      ev("cost.recorded", 1100, {
        nodeId: "n1",
        input_tokens: 100,
        output_tokens: 42,
        total_tokens: 142,
        cost_usd: 0.003,
        cache_read_tokens: 10,
      }),
    ];
    const [s] = eventsToSteps(events);
    expect(s!.cost).toBeUndefined();
  });

  test("loop iterations produce one step per llm.start, each keeping its own finalText", () => {
    const events = [
      ev("llm.start", 1000, { nodeId: "body", iteration: { n: 1, max: 3 }, prompt: "iter 1" }),
      ev("llm.text_delta", 1010, { nodeId: "body", delta: "A" }),
      ev("llm.done", 1020, { nodeId: "body" }),
      ev("llm.start", 2000, { nodeId: "body", iteration: { n: 2, max: 3 }, prompt: "iter 2" }),
      ev("llm.text_delta", 2010, { nodeId: "body", delta: "B" }),
      ev("llm.done", 2020, { nodeId: "body" }),
    ];
    const steps = eventsToSteps(events);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.finalText).toBe("A");
    expect(steps[0]!.iteration).toEqual({ n: 1, max: 3 });
    expect(steps[1]!.finalText).toBe("B");
    expect(steps[1]!.iteration).toEqual({ n: 2, max: 3 });
    // Ordering by stream order: stepIdx matches position.
    expect(steps[0]!.stepIdx).toBe(0);
    expect(steps[1]!.stepIdx).toBe(1);
  });

  test("events without nodeId (other than llm.start) are ignored", () => {
    const events = [
      ev("llm.start", 1000, { nodeId: "n1", prompt: "q" }),
      ev("llm.text_delta", 1100, { delta: "ghost" }),
      ev("llm.done", 1200, { nodeId: "n1" }),
    ];
    const [s] = eventsToSteps(events);
    expect(s!.finalText).toBe("");
  });

  test("events for an unknown nodeId (no open step) are dropped", () => {
    const events = [
      ev("llm.start", 1000, { nodeId: "n1", prompt: "q" }),
      ev("llm.text_delta", 1100, { nodeId: "different-node", delta: "nope" }),
    ];
    const [s] = eventsToSteps(events);
    expect(s!.finalText).toBe("");
  });

  test("partial / malformed settings / budget fields are tolerated", () => {
    const events = [
      ev("llm.start", 1000, {
        nodeId: "n1",
        prompt: "q",
        settings: { temperature: 0.7 },
        budget: { cumulative_cost_usd: 0.5, cumulative_tokens: 1234 },
      }),
    ];
    const [s] = eventsToSteps(events);
    expect(s!.settings).toEqual({ temperature: 0.7 });
    expect(s!.budget).toEqual({ cumulative_cost_usd: 0.5, cumulative_tokens: 1234 });
  });

  test("missing prompt / systemPrompt default to empty strings, not undefined", () => {
    const events = [ev("llm.start", 1000, { nodeId: "n1" })];
    const [s] = eventsToSteps(events);
    expect(s!.prompt).toBe("");
    expect(s!.systemPrompt).toBe("");
    expect(s!.finalText).toBe("");
  });

  test("attachStepAggregates merges SQL-aggregated cost rows by startSeq", () => {
    // The route handler runs eventsToSteps + getStepAggregates and
    // merges with `attachStepAggregates`. Verify the merge function
    // here; the SQL itself is exercised by the store-level tests.
    const events = [
      { type: "llm.start", ts: 1000, seq: 10, payload: { nodeId: "n1", prompt: "q" } },
      { type: "llm.start", ts: 2000, seq: 20, payload: { nodeId: "n2", prompt: "q2" } },
    ];
    const baseSteps = eventsToSteps(events);
    expect(baseSteps[0]!.startSeq).toBe(10);
    expect(baseSteps[1]!.startSeq).toBe(20);

    const merged = attachStepAggregates(baseSteps, [
      {
        startSeq: 10,
        costUsd: 0.006,
        inputTokens: 50,
        outputTokens: 200,
        cacheReadTokens: 500,
        cacheWriteTokens: 0,
        totalTokens: 750,
        costEventCount: 2,
      },
      {
        startSeq: 20,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        costEventCount: 0,
      },
    ]);
    expect(merged[0]!.cost).toEqual({
      input_tokens: 50,
      output_tokens: 200,
      total_tokens: 750,
      cost_usd: 0.006,
      cache_read_tokens: 500,
      cache_write_tokens: 0,
    });
    // No cost events → no cost attached, even with a row present.
    expect(merged[1]!.cost).toBeUndefined();
  });

  test("attachStepAggregates leaves steps untouched when no aggregate matches their startSeq", () => {
    const events = [{ type: "llm.start", ts: 1000, seq: 99, payload: { nodeId: "n1", prompt: "q" } }];
    const baseSteps = eventsToSteps(events);
    const merged = attachStepAggregates(baseSteps, []);
    expect(merged[0]!.cost).toBeUndefined();
    expect(merged[0]!.startSeq).toBe(99);
  });

  test("skills array is coerced safely, scope defaults to 'project' on unknown values", () => {
    const events = [
      ev("llm.start", 1000, {
        nodeId: "n1",
        prompt: "q",
        skills: [
          {
            name: "design",
            location: "~/.agents/skills/design",
            sha256: "abc",
            bytes: 10,
            scope: "user",
            source_dir: "~/.agents",
          },
          {
            name: "frontend",
            location: "./.agents/skills/frontend",
            sha256: "def",
            bytes: 20,
            scope: "bogus",
            source_dir: ".",
          },
        ],
      }),
    ];
    const [s] = eventsToSteps(events);
    expect(s!.skills).toHaveLength(2);
    expect(s!.skills[0]!.scope).toBe("user");
    expect(s!.skills[1]!.scope).toBe("project");
  });
});
