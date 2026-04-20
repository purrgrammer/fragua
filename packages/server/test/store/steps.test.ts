// Unit tests for the eventsToSteps reducer.

import { describe, expect, test } from "bun:test";
import type { StoredEvent } from "@swarm/store";
import { eventsToSteps } from "../../src/store/steps.ts";

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

  test("llm.done sets endedAt, durationMs, stopReason and closes the step", () => {
    const events = [
      ev("llm.start", 1_000_000, { nodeId: "n1", prompt: "q" }),
      ev("llm.text_delta", 1_000_500, { nodeId: "n1", delta: "ok" }),
      ev("llm.done", 1_003_200, { nodeId: "n1", stop_reason: "end_turn" }),
      // Next text_delta has no open step: should be ignored, not re-attach.
      ev("llm.text_delta", 1_003_300, { nodeId: "n1", delta: "should-not-appear" }),
    ];
    const [s] = eventsToSteps(events);
    expect(s!.finalText).toBe("ok");
    expect(s!.stopReason).toBe("end_turn");
    expect(s!.durationMs).toBe(3200);
    expect(s!.endedAt).toBe(new Date(1_003_200).toISOString());
  });

  test("cost.recorded folds into the open step's cost", () => {
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
    expect(s!.cost).toEqual({
      input_tokens: 100,
      output_tokens: 42,
      total_tokens: 142,
      cost_usd: 0.003,
      cache_read_tokens: 10,
    });
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

  test("skills array is coerced safely, scope defaults to 'project' on unknown values", () => {
    const events = [
      ev("llm.start", 1000, {
        nodeId: "n1",
        prompt: "q",
        skills: [
          { name: "design", location: "~/.agents/skills/design", sha256: "abc", bytes: 10, scope: "user", source_dir: "~/.agents" },
          { name: "frontend", location: "./.agents/skills/frontend", sha256: "def", bytes: 20, scope: "bogus", source_dir: "." },
        ],
      }),
    ];
    const [s] = eventsToSteps(events);
    expect(s!.skills).toHaveLength(2);
    expect(s!.skills[0]!.scope).toBe("user");
    expect(s!.skills[1]!.scope).toBe("project");
  });
});
