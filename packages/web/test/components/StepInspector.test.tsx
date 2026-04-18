// StepInspector renders the per-step panels (Prompt, System prompt,
// Messages, Tools, Context files, Settings, Budget, Final text) from a
// `StepSnapshot[]` pulled via `api.getPipelineSteps`.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { StepInspector } from "../../src/components/StepInspector.tsx";
import type { ApiClient, StepSnapshot } from "../../src/lib/api.ts";
import { useDom } from "../setup.ts";

function makeClient(steps: StepSnapshot[]): ApiClient {
  const baseUrl = "/api";
  const eventsUrl = (id: string) => `${baseUrl}/pipelines/${id}/events`;
  return {
    baseUrl,
    health: async () => ({ ok: true }),
    listPipelines: async () => [],
    listWorkflows: async () => [],
    getPipeline: async (id: string) => ({
      runId: id,
      startedAt: "2024-01-01T00:00:00Z",
      status: "unknown" as const,
      lastEventSeq: 0,
      nodes: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    }),
    getPipelineEvents: async () => ({ events: [], lastSeq: 0 }),
    getPipelineSteps: async () => steps,
    listSkills: async () => [],
    getSkill: async () => {
      throw new Error("getSkill not stubbed");
    },
    getPipelineEventsUrl: eventsUrl,
    pipelineEventsUrl: eventsUrl,
  };
}

function makeStep(overrides: Partial<StepSnapshot> = {}): StepSnapshot {
  return {
    stepIdx: 0,
    nodeId: "plan",
    startedAt: "2024-01-01T00:00:00.000Z",
    prompt: "make a plan",
    systemPrompt: "you are helpful",
    allowedTools: [],
    deniedTools: [],
    messages: [],
    contextFiles: [],
    skills: [],
    finalText: "",
    ...overrides,
  };
}

describe("StepInspector", () => {
  useDom();
  afterEach(() => cleanup());

  it("shows a loading indicator, then renders one row per step", async () => {
    const steps = [
      makeStep({ stepIdx: 0, nodeId: "plan" }),
      makeStep({ stepIdx: 1, nodeId: "implement", model: "claude-opus-4-7", provider: "anthropic" }),
    ];
    const { container } = render(<StepInspector api={makeClient(steps)} runId="r1" />);
    const q = within(container);
    expect(q.getByTestId("step-inspector-loading")).toBeTruthy();
    await waitFor(() => {
      expect(q.getByTestId("step-inspector")).toBeTruthy();
    });
    expect(q.getByTestId("step-0")).toBeTruthy();
    expect(q.getByTestId("step-1")).toBeTruthy();
  });

  it("empty array → empty state (not an error)", async () => {
    const { container } = render(<StepInspector api={makeClient([])} runId="r1" />);
    await waitFor(() => {
      expect(within(container).getByTestId("step-inspector-empty")).toBeTruthy();
    });
  });

  it("renders prompt + system prompt bodies verbatim inside the expandable step", async () => {
    const steps = [makeStep({ prompt: "what's the answer?", systemPrompt: "THE BASE SYSTEM PROMPT" })];
    const { container } = render(<StepInspector api={makeClient(steps)} runId="r1" />);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("step-0")).toBeTruthy();
    });
    expect(q.getByText("what's the answer?")).toBeTruthy();
    expect(q.getByText("THE BASE SYSTEM PROMPT")).toBeTruthy();
  });

  it("surfaces context_files with truncated + missing badges", async () => {
    const steps = [
      makeStep({
        contextFiles: [
          { path: "AGENTS.md", sha256: "a".repeat(64), bytes: 12_000, truncated: true, status: "ok" },
          { path: "NOPE.md", sha256: "", bytes: 0, truncated: false, status: "missing", error: "ENOENT" },
        ],
      }),
    ];
    const { container } = render(<StepInspector api={makeClient(steps)} runId="r1" />);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("step-0")).toBeTruthy();
    });
    expect(q.getByText("AGENTS.md")).toBeTruthy();
    expect(q.getByText("NOPE.md")).toBeTruthy();
    expect(q.getByText("truncated")).toBeTruthy();
    expect(q.getByText("missing")).toBeTruthy();
  });
});
