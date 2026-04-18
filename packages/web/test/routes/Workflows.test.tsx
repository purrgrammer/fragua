// Route-level tests for `/workflows`. Same pattern as PipelinesList:
// stub the ApiClient (or pass a `fetcher` prop), mount inside a memory
// router, and assert table rows + empty state.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import type { ApiClient, WorkflowSummary } from "../../src/lib/api.ts";
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
    getPipelineSteps: overrides.getPipelineSteps ?? (async () => []),
    listSkills: overrides.listSkills ?? (async () => []),
    getSkill:
      overrides.getSkill ??
      (async () => {
        throw new Error("getSkill not stubbed");
      }),
    getPipelineEventsUrl: eventsUrl,
    pipelineEventsUrl: eventsUrl,
    ...overrides,
  };
}

function mount(api: ApiClient, path = "/workflows") {
  const router = createMemoryRouter(createRoutes({ api }), { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

describe("Workflows route", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders one row per workflow with name / path / short sha", async () => {
    const rows: WorkflowSummary[] = [
      { name: "alpha", path: "workflows/alpha.dot", sha: "abcdef1234567890", label: "Alpha" },
      { name: "beta", path: "workflows/beta.dot", sha: "fedcba0987654321" },
    ];
    const api = makeClient({ listWorkflows: async () => rows });
    const { container } = mount(api);
    const q = within(container);

    await waitFor(() => {
      expect(q.getByTestId("workflows-table")).toBeTruthy();
    });

    expect(q.getByTestId("workflow-row-alpha")).toBeTruthy();
    expect(q.getByTestId("workflow-row-beta")).toBeTruthy();
    // Label preferred over name when present.
    expect(q.getByText("Alpha")).toBeTruthy();
    // First-7-char short sha. The full sha must NOT appear in the cell.
    expect(q.getByText("abcdef1")).toBeTruthy();
    expect(q.queryByText("abcdef1234567890")).toBeNull();
  });

  it("renders the empty state when no workflows exist", async () => {
    const api = makeClient({ listWorkflows: async () => [] });
    const { container } = mount(api);
    await waitFor(() => {
      expect(within(container).getByTestId("workflows-empty")).toBeTruthy();
    });
    // Table must not render in the empty state.
    expect(within(container).queryByTestId("workflows-table")).toBeNull();
  });

  it("renders the error state when the fetch rejects", async () => {
    // Silence the expected console.warn so test output stays clean.
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const api = makeClient({
        listWorkflows: async () => {
          throw new Error("nope");
        },
      });
      const { container } = mount(api);
      await waitFor(() => {
        expect(within(container).getByTestId("workflows-error")).toBeTruthy();
      });
      expect(container.textContent ?? "").not.toContain("nope");
    } finally {
      console.warn = origWarn;
    }
  });
});
