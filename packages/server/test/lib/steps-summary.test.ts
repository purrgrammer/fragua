// Wave 6: summariser calls show up as their own steps in the
// StepInspector, with streaming deltas folded into finalText.

import { describe, expect, test } from "bun:test";
import type { Event } from "@swarm/core";
import { eventsToSteps } from "../../src/lib/steps.ts";

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

describe("eventsToSteps — summariser integration (Wave 6)", () => {
  test("summary.started opens a step; text_delta events fold into finalText", () => {
    const steps = eventsToSteps([
      ev(
        "summary.started",
        "__summary.title",
        { purpose: "title", provider: "openrouter", model: "haiku" },
        "2026-04-18T00:00:00.000Z",
      ),
      ev("summary.text_delta", "__summary.title", { purpose: "title", delta: "Refactor " }, "2026-04-18T00:00:00.250Z"),
      ev(
        "summary.text_delta",
        "__summary.title",
        { purpose: "title", delta: "PipelineRow" },
        "2026-04-18T00:00:00.500Z",
      ),
      ev(
        "cost.recorded",
        "__summary.title",
        { provider: "openrouter", model: "haiku", cost_usd: 0.00012, input_tokens: 40, output_tokens: 5 },
        "2026-04-18T00:00:00.900Z",
      ),
      ev(
        "summary.completed",
        "__summary.title",
        {
          purpose: "title",
          provider: "openrouter",
          model: "haiku",
          output_text: "Refactor PipelineRow",
          cost_usd: 0.00012,
          input_tokens: 40,
          output_tokens: 5,
          duration_ms: 900,
        },
        "2026-04-18T00:00:01.000Z",
      ),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.nodeId).toBe("__summary.title");
    expect(steps[0]!.finalText).toBe("Refactor PipelineRow");
    expect(steps[0]!.cost?.cost_usd).toBe(0.00012);
    expect(steps[0]!.durationMs).toBe(1000);
  });

  test("no text_delta events → finalText falls back to summary.completed.output_text", () => {
    const steps = eventsToSteps([
      ev("summary.started", "__summary.title", { purpose: "title" }, "t0"),
      ev(
        "summary.completed",
        "__summary.title",
        {
          purpose: "title",
          output_text: "Full title only",
          cost_usd: 0.0001,
          input_tokens: 10,
          output_tokens: 3,
          duration_ms: 5,
        },
        "2026-04-18T00:00:00.500Z",
      ),
    ]);
    expect(steps[0]!.finalText).toBe("Full title only");
  });

  test("llm.start + summary.started on different nodes produce distinct steps", () => {
    const steps = eventsToSteps([
      ev("summary.started", "__summary.title", { purpose: "title" }, "t0"),
      ev("summary.text_delta", "__summary.title", { purpose: "title", delta: "Title" }, "t0b"),
      ev(
        "summary.completed",
        "__summary.title",
        { purpose: "title", output_text: "Title", cost_usd: 0, input_tokens: 0, output_tokens: 0, duration_ms: 1 },
        "t0c",
      ),
      ev("llm.start", "plan", { prompt: "p", system_prompt: "s" }, "t1"),
      ev("llm.text_delta", "plan", { delta: "planning" }, "t1b"),
      ev("llm.done", "plan", { stop_reason: "stop" }, "t1c"),
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.nodeId).toBe("__summary.title");
    expect(steps[1]!.nodeId).toBe("plan");
    expect(steps[1]!.finalText).toBe("planning");
  });
});
