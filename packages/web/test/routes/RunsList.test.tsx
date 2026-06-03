// Route-level tests for RunsList. We seed the react-query cache via
// `setQueryData` for happy-path renders (no network), and install a URL-
// routing fake `fetch` when a test needs to exercise the loading or
// error paths.

import { cleanup, render, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, test } from "vitest";
import { RunRow } from "../../src/components/RunRow.tsx";
import type { RunSummary } from "../../src/lib/api.ts";
import { queries } from "../../src/lib/queries.ts";
import { createRoutes } from "../../src/lib/router.tsx";
import { createTestQueryClient, installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";

function mount(client = createTestQueryClient(), path = "/runs") {
  const router = createMemoryRouter(createRoutes(), { initialEntries: [path] });
  return renderWithClient(<RouterProvider router={router} />, { client });
}

describe("RunsList", () => {
  afterEach(() => cleanup());

  it("renders a three-column header: Title / Workflow / Status (nothing else)", async () => {
    const client = createTestQueryClient();
    client.setQueryData(queries.runs.list().queryKey, [
      {
        runId: "r1",
        workflow: "wf-A",
        startedAt: "2024-01-01T00:00:00Z",
        status: "success",
        eventCount: 1,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    ] satisfies RunSummary[]);

    const { container } = mount(client);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("runs-table")).toBeTruthy();
    });

    const headers = Array.from(q.getByTestId("runs-table").querySelectorAll("thead th")).map((th) =>
      (th.textContent ?? "").trim(),
    );

    expect(headers).toEqual(["Title", "Workflow", "Status"]);

    for (const dropped of ["Run", "Started", "Cost", "Tokens", "Events"]) {
      expect(headers).not.toContain(dropped);
    }
  });

  it("renders one row per run with title link, workflow badge, and a status pill on the right", async () => {
    const rows: RunSummary[] = [
      {
        runId: "r1",
        title: "Summarise the weekly digest",
        workflow: "wf-A",
        startedAt: "2024-01-01T00:00:00Z",
        status: "success",
        eventCount: 3,
        costUsd: 0.12,
        inputTokens: 3000,
        outputTokens: 1200,
        durationMs: 45_000,
      },
      {
        runId: "r2",
        title: "Draft release notes",
        workflow: "wf-B",
        startedAt: "2024-01-02T00:00:00Z",
        status: "running",
        eventCount: 1,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    ];
    const client = createTestQueryClient();
    client.setQueryData(queries.runs.list().queryKey, rows);

    const { container } = mount(client);
    const q = within(container);

    await waitFor(() => {
      expect(q.getByTestId("runs-table")).toBeTruthy();
    });

    expect(q.getByText("Summarise the weekly digest")).toBeTruthy();
    expect(q.getByText("Draft release notes")).toBeTruthy();

    const links = Array.from(container.querySelectorAll("a[href]"));
    const hrefs = links.map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/runs/r1");
    expect(hrefs).toContain("/runs/r2");

    // Workflow cell uses the muted Badge variant. Asserting on
    // `data-variant` keeps the test resilient to theme-token changes.
    const wfA = q.getByText("wf-A");
    expect(wfA.getAttribute("data-variant")).toBe("muted");
    const wfB = q.getByText("wf-B");
    expect(wfB.getAttribute("data-variant")).toBe("muted");

    expect(q.getByTestId("status-success")).toBeTruthy();
    expect(q.getByTestId("status-running")).toBeTruthy();

    const successPillCell = (q.getByTestId("status-success").closest("td") as HTMLElement) ?? null;
    expect(successPillCell).toBeTruthy();
    const successRowCells = Array.from(successPillCell!.parentElement!.children);
    expect(successRowCells.indexOf(successPillCell!)).toBe(successRowCells.length - 1);
  });

  it("omits the workflow badge when the row has no workflow", async () => {
    const rows: RunSummary[] = [
      {
        runId: "no-wf",
        title: "Ad-hoc run",
        startedAt: "2024-01-01T00:00:00Z",
        status: "success",
        eventCount: 1,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    ];
    const client = createTestQueryClient();
    client.setQueryData(queries.runs.list().queryKey, rows);

    const { container } = mount(client);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("runs-table")).toBeTruthy();
    });

    const titleLink = q.getByText("Ad-hoc run").closest("a") as HTMLElement;
    const tr = titleLink.closest("tr") as HTMLElement;
    const badgesInRow = tr.querySelectorAll('span[data-variant="muted"]');
    expect(badgesInRow.length).toBe(0);
  });

  it("shows a loading indicator while pending", async () => {
    const mock = installFetchMock({
      "/api/runs": () => new Promise<Response>(() => {}),
    });
    try {
      const { container } = mount();
      expect(within(container).getByTestId("runs-loading")).toBeTruthy();
    } finally {
      mock.restore();
    }
  });

  it("renders a graceful empty state on failure, without leaking the raw error", async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    const mock = installFetchMock({
      "/api/runs": () => new Response("nope-should-not-render", { status: 500, statusText: "Internal Server Error" }),
    });
    try {
      const { container } = mount();
      await waitFor(() => {
        expect(within(container).getByTestId("runs-error")).toBeTruthy();
      });
      expect(within(container).getByRole("heading", { name: "Runs" })).toBeTruthy();
      expect(container.textContent ?? "").not.toContain("nope-should-not-render");
    } finally {
      mock.restore();
      console.warn = origWarn;
    }
  });

  it("suppresses the empty-state flash by pre-seeded cache", async () => {
    const client = createTestQueryClient();
    client.setQueryData(queries.runs.list().queryKey, [] as RunSummary[]);

    // Install a fetch fallback so a refetch stays deterministic even though
    // the component will not render a network error with seeded cache.
    const mock = installFetchMock({ "/api/runs": () => json([]) });
    try {
      const { container } = mount(client);
      await waitFor(() => {
        expect(within(container).getByTestId("runs-empty")).toBeTruthy();
      });
    } finally {
      mock.restore();
    }
  });
});

function importedRow(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "imp-1",
    startedAt: "2024-01-01T00:00:00Z",
    status: "success",
    runStatus: "completed",
    eventCount: 5,
    costUsd: 0.01,
    inputTokens: 100,
    outputTokens: 50,
    imported: true,
    title: "Imported run",
    ...overrides,
  };
}

function normalRow(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "norm-1",
    startedAt: "2024-01-01T00:00:00Z",
    status: "success",
    runStatus: "completed",
    eventCount: 5,
    costUsd: 0.01,
    inputTokens: 100,
    outputTokens: 50,
    title: "Normal run",
    ...overrides,
  };
}

describe("RunRow — imported indicator", () => {
  afterEach(() => cleanup());

  test("renders ImportedBadge alongside the status pill when row.imported is true (default / table variant)", () => {
    const row = importedRow();
    const { container } = render(
      <MemoryRouter>
        <table>
          <tbody>
            <RunRow row={row} variant="default" />
          </tbody>
        </table>
      </MemoryRouter>,
    );
    const badge = container.querySelector('[data-testid="imported-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("imported");
    expect(container.querySelector('[data-testid="status-success"]')).not.toBeNull();
  });

  test("renders ImportedBadge alongside the status pill when row.imported is true (compact variant)", () => {
    const row = importedRow();
    const { container } = render(
      <MemoryRouter>
        <RunRow row={row} variant="compact" />
      </MemoryRouter>,
    );
    const badge = container.querySelector('[data-testid="imported-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("imported");
  });

  test("does NOT render ImportedBadge when row.imported is false/undefined (default variant)", () => {
    const row = normalRow();
    const { container } = render(
      <MemoryRouter>
        <table>
          <tbody>
            <RunRow row={row} variant="default" />
          </tbody>
        </table>
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-testid="imported-badge"]')).toBeNull();
  });

  test("does NOT render ImportedBadge when row.imported is false/undefined (compact variant)", () => {
    const row = normalRow();
    const { container } = render(
      <MemoryRouter>
        <RunRow row={row} variant="compact" />
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-testid="imported-badge"]')).toBeNull();
  });
});
