// Route-level tests for Home — the dashboard landing.
//
// We assert each of the three sections (running strip, stats tiles,
// recent runs) against an injected fixture API. Tests deliberately
// stub `listPipelines` rather than the lower-level `fetcher` prop so
// the full code path (props → fetch → reducer → render) is exercised.
//
// Polling is left running because:
//   - the 5s interval doesn't fire within a sub-second test;
//   - cleanup() unmounts the component, which clears the timer in the
//     useEffect returned cleanup;
// so tests stay simple without a fake-timer harness.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import type { ApiClient, PipelineSummary } from "../../src/lib/api.ts";
import { createRoutes } from "../../src/lib/router.tsx";
import { useDom } from "../setup.ts";

function makeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const baseUrl = overrides.baseUrl ?? "/api";
  const eventsUrl = overrides.getPipelineEventsUrl ?? ((id: string) => `${baseUrl}/pipelines/${id}/events`);
  return {
    baseUrl,
    health: async () => ({ ok: true }),
    listPipelines: overrides.listPipelines ?? (async () => []),
    listWorkflows: overrides.listWorkflows ?? (async () => []),
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
    getPipelineEvents: overrides.getPipelineEvents ?? (async () => ({ events: [], lastSeq: 0 })),
    getPipelineEventsUrl: eventsUrl,
    getPipelineSteps: async () => [],
    steerRun: async () => ({ id: "stub" }),
    pauseRun: async () => ({ id: "stub" }),
    resumeRun: async () => ({ id: "stub" }),
    cancelRun: async () => ({ id: "stub" }),
    listSkills: async () => [],
    getSkill: async () => {
      throw new Error("getSkill not stubbed");
    },
    pipelineEventsUrl: eventsUrl,
    ...overrides,
  };
}

function row(overrides: Partial<PipelineSummary> = {}): PipelineSummary {
  return {
    runId: overrides.runId ?? "run-x",
    startedAt: overrides.startedAt ?? "2024-01-01T00:00:00Z",
    status: overrides.status ?? "success",
    eventCount: overrides.eventCount ?? 1,
    costUsd: overrides.costUsd ?? 0,
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    ...(overrides.cacheReadTokens !== undefined ? { cacheReadTokens: overrides.cacheReadTokens } : {}),
    ...(overrides.cacheWriteTokens !== undefined ? { cacheWriteTokens: overrides.cacheWriteTokens } : {}),
    ...(overrides.workflow !== undefined ? { workflow: overrides.workflow } : {}),
    ...(overrides.workflowName !== undefined ? { workflowName: overrides.workflowName } : {}),
    ...(overrides.durationMs !== undefined ? { durationMs: overrides.durationMs } : {}),
  };
}

function mount(api: ApiClient, path = "/") {
  const router = createMemoryRouter(createRoutes({ api }), { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

describe("Home route", () => {
  useDom();
  afterEach(() => cleanup());

  it("shows the running-strip empty state when nothing is in progress", async () => {
    const api = makeClient({
      listPipelines: async () => [
        row({ runId: "a", status: "success", durationMs: 1_000 }),
        row({ runId: "b", status: "fail", durationMs: 2_000 }),
      ],
    });
    const { container } = mount(api);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("running-empty")).toBeTruthy();
    });
    // No running cards should be present.
    expect(container.querySelectorAll("[data-testid^=running-card-]").length).toBe(0);
  });

  it("renders one card per running pipeline", async () => {
    const api = makeClient({
      listPipelines: async () => [
        row({ runId: "live-1", status: "running", workflow: "wf-A", eventCount: 7 }),
        row({ runId: "live-2", status: "running", workflow: "wf-B", eventCount: 3 }),
        row({ runId: "done", status: "success", durationMs: 1_000 }),
      ],
    });
    const { container } = mount(api);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("running-card-live-1")).toBeTruthy();
    });
    expect(q.getByTestId("running-card-live-2")).toBeTruthy();
    // The completed run does NOT appear in the running strip.
    expect(q.queryByTestId("running-card-done")).toBeNull();
  });

  it("renders the six stats tiles populated from the reducer", async () => {
    const api = makeClient({
      listPipelines: async () => [
        row({
          runId: "a",
          status: "success",
          costUsd: 0.1,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 300,
          cacheWriteTokens: 40,
          durationMs: 10_000,
        }),
        row({
          runId: "b",
          status: "fail",
          costUsd: 0.05,
          inputTokens: 50,
          outputTokens: 25,
          cacheReadTokens: 100,
          durationMs: 20_000,
        }),
        row({ runId: "c", status: "running", costUsd: 0.01, inputTokens: 5, outputTokens: 5 }),
      ],
    });
    const { container } = mount(api);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("tile-total")).toBeTruthy();
    });
    expect(q.getByTestId("tile-total").textContent).toContain("3");
    // Success rate over terminal runs (1 of 2) → 50%.
    expect(q.getByTestId("tile-success").textContent).toContain("50%");
    // Total spend renders as USD.
    expect(q.getByTestId("tile-spend").textContent).toMatch(/\$0\.16/);
    // Total tokens — 235 in long form (under 1000, no compact suffix).
    expect(q.getByTestId("tile-tokens").textContent).toContain("235");
    // Cache hit rate: (300+100) / ((100+50+5) + (300+100)) = 400/555 → 72%.
    expect(q.getByTestId("tile-cache").textContent).toContain("72%");
    // Avg duration is over terminal runs only: (10s + 20s) / 2 = 15s.
    expect(q.getByTestId("tile-duration").textContent).toContain("15s");
  });

  it("renders at most ten rows in Recent runs", async () => {
    const many: PipelineSummary[] = Array.from({ length: 15 }, (_, i) =>
      row({
        runId: `run-${i.toString().padStart(2, "0")}`,
        startedAt: `2024-01-${(i + 1).toString().padStart(2, "0")}T00:00:00Z`,
        status: "success",
        durationMs: 1_000,
      }),
    );
    const api = makeClient({ listPipelines: async () => many });
    const { container } = mount(api);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("recent-runs")).toBeTruthy();
    });
    const rows = container.querySelectorAll("[data-testid^=recent-run-]");
    expect(rows.length).toBe(10);
  });

  it("shows skeletons before the first response resolves", () => {
    // listPipelines never resolves → state stays "loading".
    const api = makeClient({ listPipelines: () => new Promise(() => {}) });
    const { container } = mount(api);
    // Skeletons render with `.sw-pulse` (design-system pulse: 1800ms ease-in-out,
    // `prefers-reduced-motion` aware). We assert the running strip is in loading
    // mode by querying for the test id and checking no real cards are rendered.
    expect(within(container).getByTestId("running-strip")).toBeTruthy();
    expect(within(container).queryByTestId("running-empty")).toBeNull();
    expect(container.querySelectorAll(".sw-pulse").length).toBeGreaterThan(0);
  });
});
