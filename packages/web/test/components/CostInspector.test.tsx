// CostInspector renders one row per LLM call with model, duration,
// total cost, and a click-to-open context ring.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, waitFor, within } from "@testing-library/react";
import { CostInspector } from "../../src/components/CostInspector.tsx";
import type { StepSnapshot } from "../../src/lib/api.ts";
import { createTestQueryClient, installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

function makeStep(overrides: Partial<StepSnapshot> = {}): StepSnapshot {
  return {
    stepIdx: 0,
    startSeq: 0,
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
  client.setQueryData(["runs", "steps", runId], steps);
  return renderWithClient(<CostInspector runId={runId} />, { client });
}

describe("CostInspector", () => {
  useDom();
  afterEach(() => cleanup());

  it("shows a loading indicator, then renders one row per LLM call", async () => {
    const steps = [
      makeStep({ stepIdx: 0, startSeq: 1, nodeId: "plan" }),
      makeStep({ stepIdx: 1, startSeq: 2, nodeId: "implement", model: "claude-opus-4-7", provider: "anthropic" }),
    ];
    const client = createTestQueryClient();
    let resolve: (r: Response) => void = () => {};
    const mock = installFetchMock({
      "/api/runs/r1/steps": () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    });
    try {
      const { container } = renderWithClient(<CostInspector runId="r1" />, { client });
      const q = within(container);
      expect(q.getByTestId("cost-inspector-loading")).toBeTruthy();
      resolve(json(steps));
      await waitFor(() => {
        expect(q.getByTestId("cost-inspector")).toBeTruthy();
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
      expect(within(container).getByTestId("cost-inspector-empty")).toBeTruthy();
    });
  });

  it("renders nodeId, provider/model, and total cost on each row", async () => {
    const steps = [
      makeStep({
        stepIdx: 0,
        startSeq: 1,
        nodeId: "verify",
        provider: "anthropic",
        model: "claude-sonnet-4.6",
        durationMs: 12_000,
        cost: { input_tokens: 1000, output_tokens: 100, cost_usd: 0.05 },
      }),
    ];
    const { container } = mount("r1", steps);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("step-0")).toBeTruthy();
    });
    expect(q.getByText("verify")).toBeTruthy();
    expect(q.getByText("anthropic / claude-sonnet-4.6")).toBeTruthy();
    // Total cost lives in the metrics row; AnimatedNumber renders the formatted text.
    expect(q.getByText(/US\$0\.050|0\.050/)).toBeTruthy();
  });
});
