// Unit tests for the eventsToSteps / stepsProjection reducer. Keeps
// the route-level assertions (packages/server/test/routes/pipelines-steps.test.ts)
// thin by covering the shape rules here.

import { describe, expect, test } from "bun:test";
import type { Event } from "@swarm/core";
import { eventsToSteps, STEPS_PROJECTION_KEY, stepsProjection } from "../../src/lib/steps.ts";

function ev(
  type: string,
  node_id: string | undefined,
  data: Record<string, unknown>,
  timestamp = "2026-04-18T00:00:00.000Z",
): Event {
  const base = {
    run_id: "r1",
    type: type as Event["type"],
    timestamp,
    workflow_sha: "sha",
    schema_version: 1,
    data,
  };
  return node_id ? { ...base, node_id } : base;
}

describe("eventsToSteps — Wave 5 reducer", () => {
  test("empty input → empty array", () => {
    expect(eventsToSteps([])).toEqual([]);
  });

  test("one llm.start → one step with the core fields", () => {
    const steps = eventsToSteps([
      ev("llm.start", "plan", {
        provider: "anthropic",
        model: "claude-opus-4-7",
        prompt: "what's next?",
        system_prompt: "you are helpful",
        thread_id: "dev",
        fidelity: "full",
        allowed_tools: ["local:read_file"],
      }),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      stepIdx: 0,
      nodeId: "plan",
      provider: "anthropic",
      model: "claude-opus-4-7",
      prompt: "what's next?",
      systemPrompt: "you are helpful",
      threadId: "dev",
      fidelity: "full",
      allowedTools: ["local:read_file"],
      deniedTools: [],
      messages: [],
      contextFiles: [],
      finalText: "",
    });
  });

  test("text_delta events fold into finalText in order", () => {
    const steps = eventsToSteps([
      ev("llm.start", "n", { prompt: "p", system_prompt: "s" }, "2026-04-18T00:00:00.000Z"),
      ev("llm.text_delta", "n", { delta: "hello ", content_index: 0 }, "2026-04-18T00:00:00.001Z"),
      ev("llm.text_delta", "n", { delta: "world", content_index: 0 }, "2026-04-18T00:00:00.002Z"),
    ]);
    expect(steps[0]!.finalText).toBe("hello world");
  });

  test("llm.done closes the step and computes durationMs + stopReason", () => {
    const steps = eventsToSteps([
      ev("llm.start", "n", { prompt: "p", system_prompt: "s" }, "2026-04-18T00:00:00.000Z"),
      ev("llm.done", "n", { stop_reason: "stop" }, "2026-04-18T00:00:00.750Z"),
      // After llm.done the step is closed — a stray text_delta from a
      // misbehaving backend must not append to it.
      ev("llm.text_delta", "n", { delta: "late" }, "2026-04-18T00:00:01.000Z"),
    ]);
    expect(steps[0]!.stopReason).toBe("stop");
    expect(steps[0]!.durationMs).toBe(750);
    expect(steps[0]!.finalText).toBe("");
  });

  test("cost.recorded attaches cost onto the owning step", () => {
    const steps = eventsToSteps([
      ev("llm.start", "n", { prompt: "p", system_prompt: "s" }),
      ev("cost.recorded", "n", {
        cost_usd: 0.02,
        input_tokens: 100,
        output_tokens: 40,
        total_tokens: 140,
      }),
    ]);
    expect(steps[0]!.cost).toEqual({ input_tokens: 100, output_tokens: 40, total_tokens: 140, cost_usd: 0.02 });
  });

  test("context_files records pass through with sha256 + status", () => {
    const steps = eventsToSteps([
      ev("llm.start", "n", {
        prompt: "p",
        system_prompt: "s",
        context_files: [
          { path: "AGENTS.md", sha256: "a".repeat(64), bytes: 123, truncated: false, status: "ok" },
          { path: "missing.md", sha256: "", bytes: 0, truncated: false, status: "missing", error: "ENOENT" },
        ],
      }),
    ]);
    expect(steps[0]!.contextFiles).toEqual([
      { path: "AGENTS.md", sha256: "a".repeat(64), bytes: 123, truncated: false, status: "ok" },
      { path: "missing.md", sha256: "", bytes: 0, truncated: false, status: "missing", error: "ENOENT" },
    ]);
  });

  test("budget + settings + iteration pass through", () => {
    const steps = eventsToSteps([
      ev("llm.start", "n", {
        prompt: "p",
        system_prompt: "s",
        budget: { cumulative_cost_usd: 0.1, cumulative_tokens: 20, max_cost_usd: 0.5 },
        settings: { reasoning_effort: "high" },
        iteration: { n: 2, max: 3 },
      }),
    ]);
    expect(steps[0]!.budget).toMatchObject({ cumulative_cost_usd: 0.1, max_cost_usd: 0.5 });
    expect(steps[0]!.settings).toEqual({ reasoning_effort: "high" });
    expect(steps[0]!.iteration).toEqual({ n: 2, max: 3 });
  });

  test("loop iterations share a nodeId but produce distinct steps", () => {
    const steps = eventsToSteps([
      ev("llm.start", "loop", { prompt: "iter 1", system_prompt: "s", iteration: { n: 1, max: 3 } }, "t1"),
      ev("llm.done", "loop", { stop_reason: "stop" }, "t1b"),
      ev("llm.start", "loop", { prompt: "iter 2", system_prompt: "s", iteration: { n: 2, max: 3 } }, "t2"),
      ev("llm.done", "loop", { stop_reason: "stop" }, "t2b"),
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.iteration?.n).toBe(1);
    expect(steps[1]!.iteration?.n).toBe(2);
    expect(steps[0]!.stepIdx).toBe(0);
    expect(steps[1]!.stepIdx).toBe(1);
  });

  test("stepsProjection is a trivial wrapper around eventsToSteps", () => {
    const events = [ev("llm.start", "n", { prompt: "p", system_prompt: "s" })];
    expect(stepsProjection(events)).toEqual(eventsToSteps(events));
  });

  test("STEPS_PROJECTION_KEY is a stable string for cache adapters", () => {
    expect(STEPS_PROJECTION_KEY).toBe("steps");
  });
});
