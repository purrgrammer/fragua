// Route-level tests for /jobs. Mount inside a memory router, seed the
// react-query cache via `setQueryData` for happy-path renders, and use
// a URL-routing fake `fetch` for the mutation + error paths.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import type { JobSummary } from "../../src/lib/api.ts";
import { queries } from "../../src/lib/queries.ts";
import { createRoutes } from "../../src/lib/router.tsx";
import { createTestQueryClient, installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

function mount(client = createTestQueryClient(), path = "/jobs") {
  const router = createMemoryRouter(createRoutes(), { initialEntries: [path] });
  return renderWithClient(<RouterProvider router={router} />, { client });
}

function withJobs(rows: JobSummary[]) {
  const client = createTestQueryClient();
  client.setQueryData(queries.jobs.list({ limit: 100 }).queryKey, rows);
  return client;
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
    const { container } = mount(withJobs(rows));
    await waitFor(() => {
      expect(within(container).getByTestId("jobs-table")).toBeTruthy();
    });
    expect(within(container).getByTestId("job-row-a")).toBeTruthy();
    expect(within(container).getByTestId("job-row-b")).toBeTruthy();
    expect(within(container).getByTestId("job-row-c")).toBeTruthy();
    const links = Array.from(container.querySelectorAll("a[href]"));
    const hrefs = links.map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/pipelines/run-a");
    expect(hrefs).toContain("/pipelines/run-b");
    expect(hrefs).toContain("/pipelines/run-c");
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
    const { container } = mount(withJobs(rows));
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("jobs-table")).toBeTruthy();
    });
    expect(q.queryByTestId("job-cancel-queued")).toBeTruthy();
    expect(q.queryByTestId("job-cancel-running")).toBeTruthy();
    expect(q.queryByTestId("job-cancel-done")).toBeNull();
  });

  it("calls DELETE /jobs/:id when the cancel button is clicked", async () => {
    const client = withJobs([job({ id: "j1", status: "queued" })]);
    const mock = installFetchMock({
      "/api/jobs/j1": ({ method }) => {
        if (method === "DELETE") return json({ status: "removed", jobId: "j1" });
        return new Response("method not allowed", { status: 405 });
      },
    });
    try {
      const { container } = mount(client);
      const q = within(container);
      await waitFor(() => expect(q.getByTestId("job-cancel-j1")).toBeTruthy());
      fireEvent.click(q.getByTestId("job-cancel-j1"));
      await waitFor(() => {
        expect(mock.calls.some((c) => c.url === "/api/jobs/j1" && c.method === "DELETE")).toBe(true);
      });
    } finally {
      mock.restore();
    }
  });

  it("renders the empty state when the queue is empty", async () => {
    const { container } = mount(withJobs([]));
    await waitFor(() => {
      expect(within(container).getByTestId("jobs-empty")).toBeTruthy();
    });
    expect(within(container).queryByTestId("jobs-table")).toBeNull();
  });

  it("renders the 'daemon not running' state when the API returns 503", async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    const mock = installFetchMock({
      "/api/jobs?limit=100": () => new Response("no daemon", { status: 503, statusText: "Service Unavailable" }),
    });
    try {
      const { container } = mount();
      await waitFor(() => {
        expect(within(container).getByTestId("jobs-no-daemon")).toBeTruthy();
      });
    } finally {
      mock.restore();
      console.warn = origWarn;
    }
  });

  it("renders a generic error state on transport failure", async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    const mock = installFetchMock({
      "/api/jobs?limit=100": () => new Response("network down", { status: 500, statusText: "Internal Server Error" }),
    });
    try {
      const { container } = mount();
      await waitFor(() => {
        expect(within(container).getByTestId("jobs-error")).toBeTruthy();
      });
      expect(container.textContent ?? "").not.toContain("network down");
    } finally {
      mock.restore();
      console.warn = origWarn;
    }
  });
});
