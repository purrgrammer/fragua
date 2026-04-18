// Route-level tests for Home — the dashboard landing.
//
// We seed the react-query cache directly with `setQueryData` so the
// render path (cache → reducer → projections) runs without any network
// round-trip. A `never`-resolving fetch is installed when we need to
// observe the loading-skeleton state.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import type { PipelineSummary } from "../../src/lib/api.ts";
import { queries } from "../../src/lib/queries.ts";
import { createRoutes } from "../../src/lib/router.tsx";
import { createTestQueryClient, installFetchMock, renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

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

function mount(client = createTestQueryClient(), path = "/") {
  const router = createMemoryRouter(createRoutes(), { initialEntries: [path] });
  return renderWithClient(<RouterProvider router={router} />, { client });
}

function withRows(rows: PipelineSummary[]) {
  const client = createTestQueryClient();
  client.setQueryData(queries.pipelines.list().queryKey, rows);
  return client;
}

describe("Home route", () => {
  useDom();
  afterEach(() => cleanup());

  it("shows the running-strip empty state when nothing is in progress", async () => {
    const client = withRows([
      row({ runId: "a", status: "success", durationMs: 1_000 }),
      row({ runId: "b", status: "fail", durationMs: 2_000 }),
    ]);
    const { container } = mount(client);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("running-empty")).toBeTruthy();
    });
    expect(container.querySelectorAll("[data-testid^=running-card-]").length).toBe(0);
  });

  it("renders one card per running pipeline", async () => {
    const client = withRows([
      row({ runId: "live-1", status: "running", workflow: "wf-A", eventCount: 7 }),
      row({ runId: "live-2", status: "running", workflow: "wf-B", eventCount: 3 }),
      row({ runId: "done", status: "success", durationMs: 1_000 }),
    ]);
    const { container } = mount(client);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("running-card-live-1")).toBeTruthy();
    });
    expect(q.getByTestId("running-card-live-2")).toBeTruthy();
    expect(q.queryByTestId("running-card-done")).toBeNull();
  });

  it("renders the six stats tiles populated from the reducer", async () => {
    const client = withRows([
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
    ]);
    const { container } = mount(client);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("tile-total")).toBeTruthy();
    });
    expect(q.getByTestId("tile-total").textContent).toContain("3");
    expect(q.getByTestId("tile-success").textContent).toContain("50%");
    expect(q.getByTestId("tile-spend").textContent).toMatch(/\$0\.16/);
    expect(q.getByTestId("tile-tokens").textContent).toContain("235");
    expect(q.getByTestId("tile-cache").textContent).toContain("72%");
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
    const client = withRows(many);
    const { container } = mount(client);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("recent-runs")).toBeTruthy();
    });
    const rows = container.querySelectorAll("[data-testid^=recent-run-]");
    expect(rows.length).toBe(10);
  });

  it("shows skeletons before the first response resolves", () => {
    const mock = installFetchMock({
      "/api/pipelines": () => new Promise<Response>(() => {}),
    });
    try {
      const { container } = mount();
      expect(within(container).getByTestId("running-strip")).toBeTruthy();
      expect(within(container).queryByTestId("running-empty")).toBeNull();
      expect(container.querySelectorAll(".sw-pulse").length).toBeGreaterThan(0);
    } finally {
      mock.restore();
    }
  });
});
