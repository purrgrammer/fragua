// StepInspector renders the per-step panels (Prompt, System prompt,
// Messages, Tools, Context files, Settings, Budget, Final text) from a
// `StepSnapshot[]` pulled via `getPipelineSteps`.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, waitFor, within } from "@testing-library/react";
import { StepInspector } from "../../src/components/StepInspector.tsx";
import type { StepSnapshot } from "../../src/lib/api.ts";
import { createTestQueryClient, installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

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

function mount(runId: string, steps: StepSnapshot[]) {
  const client = createTestQueryClient();
  client.setQueryData(["pipelines", "steps", runId], steps);
  return renderWithClient(<StepInspector runId={runId} />, { client });
}

describe("StepInspector", () => {
  useDom();
  afterEach(() => cleanup());

  it("shows a loading indicator, then renders one row per step", async () => {
    const steps = [
      makeStep({ stepIdx: 0, nodeId: "plan" }),
      makeStep({ stepIdx: 1, nodeId: "implement", model: "claude-opus-4-7", provider: "anthropic" }),
    ];
    const client = createTestQueryClient();
    // Delay the mock fetch so the test sees the loading state.
    let resolve: (r: Response) => void = () => {};
    const mock = installFetchMock({
      "/api/pipelines/r1/steps": () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    });
    try {
      const { container } = renderWithClient(<StepInspector runId="r1" />, { client });
      const q = within(container);
      expect(q.getByTestId("step-inspector-loading")).toBeTruthy();
      resolve(json(steps));
      await waitFor(() => {
        expect(q.getByTestId("step-inspector")).toBeTruthy();
      });
      expect(q.getByTestId("step-0")).toBeTruthy();
      expect(q.getByTestId("step-1")).toBeTruthy();
    } finally {
      mock.restore();
    }
  });

  it("empty array → empty state (not an error)", async () => {
    const { container } = mount("r1", []);
    await waitFor(() => {
      expect(within(container).getByTestId("step-inspector-empty")).toBeTruthy();
    });
  });

  it("renders prompt + system prompt bodies verbatim inside the expandable step", async () => {
    const steps = [makeStep({ prompt: "what's the answer?", systemPrompt: "THE BASE SYSTEM PROMPT" })];
    const { container } = mount("r1", steps);
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
    const { container } = mount("r1", steps);
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
