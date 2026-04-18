// Route-level tests for /jobs. Mounts JobsList inside a memory
// router with a stubbed ApiClient, asserts table rows + states.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { ApiError, type ApiClient, type JobSummary } from "../../src/lib/api.ts";
import { createRoutes } from "../../src/lib/router.tsx";
import { useDom } from "../setup.ts";

function makeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const baseUrl = overrides.baseUrl ?? "/api";
  const eventsUrl = overrides.getPipelineEventsUrl ?? ((id: string) => `${baseUrl}/pipelines/${id}/events`);
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
    getPipelineSteps: async () => [],
    getPipelineEventsUrl: eventsUrl,
    steerRun: async () => ({ id: "stub" }),
    pauseRun: async () => ({ id: "stub" }),
    resumeRun: async () => ({ id: "stub" }),
    cancelRun: async () => ({ id: "stub" }),
    listJobs: overrides.listJobs ?? (async () => []),
    getJob: overrides.getJob ?? (async () => { throw new Error("getJob not stubbed"); }),
    cancelJob: overrides.cancelJob ?? (async () => ({ status: "removed", jobId: "stub" })),
    enqueueJob: overrides.enqueueJob ?? (async () => ({ jobId: "stub", runId: "stub" })),
    listSkills: async () => [],
    getSkill: async () => { throw new Error("getSkill not stubbed"); },
    pipelineEventsUrl: eventsUrl,
    ...overrides,
  };
}

function mount(api: ApiClient, path = "/jobs") {
  // pollIntervalMs=0 is injected via the route component prop default; for the
  // tests we lean on the initial fetch only (polling is visual, not correctness).
  const router = createMemoryRouter(createRoutes({ api }), { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: overrides.id ?? "j1",
    runId: overrides.runId ?? "r1",
    workflow: overrides.workflow ?? "w.dot",
    status: overrides.status ?? "queued",
    priority: overrides.priority ?? 0,
    enqueuedAt: overrides.enqueuedAt ?? new Date().toISOString(),
    worktree: overrides.worktree ?? true,
    ...(overrides.input !== undefined ? { input: overrides.input } : {}),
    ...(overrides.error !== undefined ? { error: overrides.error } : {}),
  };
}

describe("Jobs route", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders one row per job with status pills + run link", async () => {
    const rows: JobSummary[] = [
      job({ id: "a", runId: "run-a", status: "queued", workflow: "build.dot" }),
      job({ id: "b", runId: "run-b", status: "running", workflow: "fix.dot" }),
      job({ id: "c", runId: "run-c", status: "success", workflow: "build.dot" }),
    ];
    const api = makeClient({ listJobs: async () => rows });
    const { container } = mount(api);
    await waitFor(() => {
      expect(within(container).getByTestId("jobs-table")).toBeTruthy();
    });
    expect(within(container).getByTestId("job-row-a")).toBeTruthy();
    expect(within(container).getByTestId("job-row-b")).toBeTruthy();
    expect(within(container).getByTestId("job-row-c")).toBeTruthy();
    // Links point at the pipeline detail page by runId.
    const links = Array.from(container.querySelectorAll("a[href]"));
    const hrefs = links.map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/pipelines/run-a");
    expect(hrefs).toContain("/pipelines/run-b");
    expect(hrefs).toContain("/pipelines/run-c");
    // Status badges get testids so we can spot them.
    expect(within(container).getByTestId("job-status-queued")).toBeTruthy();
    expect(within(container).getByTestId("job-status-running")).toBeTruthy();
    expect(within(container).getByTestId("job-status-success")).toBeTruthy();
  });

  it("shows cancel buttons only for queued + running rows", async () => {
    const rows: JobSummary[] = [
      job({ id: "queued", status: "queued" }),
      job({ id: "running", runId: "rr", status: "running" }),
      job({ id: "done", runId: "rd", status: "success" }),
    ];
    const api = makeClient({ listJobs: async () => rows });
    const { container } = mount(api);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("jobs-table")).toBeTruthy();
    });
    expect(q.queryByTestId("job-cancel-queued")).toBeTruthy();
    expect(q.queryByTestId("job-cancel-running")).toBeTruthy();
    expect(q.queryByTestId("job-cancel-done")).toBeNull();
  });

  it("calls cancelJob when the cancel button is clicked", async () => {
    let cancelCalledWith = "";
    const api = makeClient({
      listJobs: async () => [job({ id: "j1", status: "queued" })],
      cancelJob: async (id: string) => {
        cancelCalledWith = id;
        return { status: "removed", jobId: id };
      },
    });
    const { container } = mount(api);
    const q = within(container);
    await waitFor(() => expect(q.getByTestId("job-cancel-j1")).toBeTruthy());
    fireEvent.click(q.getByTestId("job-cancel-j1"));
    await waitFor(() => expect(cancelCalledWith).toBe("j1"));
  });

  it("renders the empty state when the queue is empty", async () => {
    const api = makeClient({ listJobs: async () => [] });
    const { container } = mount(api);
    await waitFor(() => {
      expect(within(container).getByTestId("jobs-empty")).toBeTruthy();
    });
    expect(within(container).queryByTestId("jobs-table")).toBeNull();
  });

  it("renders the 'daemon not running' state when the API returns 503", async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const api = makeClient({
        listJobs: async () => {
          throw new ApiError("GET /api/jobs → 503", 503, "/api/jobs");
        },
      });
      const { container } = mount(api);
      await waitFor(() => {
        expect(within(container).getByTestId("jobs-no-daemon")).toBeTruthy();
      });
    } finally {
      console.warn = origWarn;
    }
  });

  it("renders a generic error state on transport failure", async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const api = makeClient({
        listJobs: async () => {
          throw new Error("network down");
        },
      });
      const { container } = mount(api);
      await waitFor(() => {
        expect(within(container).getByTestId("jobs-error")).toBeTruthy();
      });
      expect(container.textContent ?? "").not.toContain("network down");
    } finally {
      console.warn = origWarn;
    }
  });
});
