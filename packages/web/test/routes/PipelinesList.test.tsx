// Route-level tests for PipelinesList. We mount the component inside a
// `createMemoryRouter` so `<Link>` resolves, and stub the ApiClient rather
// than `fetch` — keeps the test focused on presentation, not transport.
//
// The list is deliberately minimal: Title / Workflow / Status. Any
// per-run detail (started-at, cost, tokens, events, duration) is viewed
// on the pipeline detail page, not listed here.

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
    listPipelines: async (): Promise<PipelineSummary[]> => [],
    listWorkflows: overrides.listWorkflows ?? (async () => []),
    getPipelineEvents: overrides.getPipelineEvents ?? (async () => ({ events: [], lastSeq: 0 })),
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

function mount(api: ApiClient, path = "/pipelines") {
  const router = createMemoryRouter(createRoutes({ api }), { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

describe("PipelinesList", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders a three-column header: Title / Workflow / Status (nothing else)", async () => {
    const api = makeClient({
      listPipelines: async () => [
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
      ],
    });
    const { container } = mount(api);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("pipelines-table")).toBeTruthy();
    });

    const headers = Array.from(q.getByTestId("pipelines-table").querySelectorAll("thead th")).map((th) =>
      (th.textContent ?? "").trim(),
    );

    // Exactly the three columns we care about.
    expect(headers).toEqual(["Title", "Workflow", "Status"]);

    // Columns we deliberately dropped stay gone.
    for (const dropped of ["Run", "Started", "Cost", "Tokens", "Events"]) {
      expect(headers).not.toContain(dropped);
    }
  });

  it("renders one row per pipeline with title link, workflow badge, and a status pill on the right", async () => {
    const rows: PipelineSummary[] = [
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
    const api = makeClient({ listPipelines: async () => rows });
    const { container } = mount(api);
    const q = within(container);

    await waitFor(() => {
      expect(q.getByTestId("pipelines-table")).toBeTruthy();
    });

    // Titles are rendered as the primary linked text.
    expect(q.getByText("Summarise the weekly digest")).toBeTruthy();
    expect(q.getByText("Draft release notes")).toBeTruthy();

    // Link targets point at /pipelines/<runId>.
    const links = Array.from(container.querySelectorAll("a[href]"));
    const hrefs = links.map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/pipelines/r1");
    expect(hrefs).toContain("/pipelines/r2");

    // Workflow is rendered inside a Badge (muted variant). The design system
    // uses --sw-* tokens instead of Tailwind palette literals, so we assert
    // on the semantic data-variant attribute rather than a bg-* class name
    // (SKILL.md § Color: "no hex literals — theme tokens only").
    const wfA = q.getByText("wf-A");
    expect(wfA.getAttribute("data-variant")).toBe("muted");
    const wfB = q.getByText("wf-B");
    expect(wfB.getAttribute("data-variant")).toBe("muted");

    // One StatusPill per row.
    expect(q.getByTestId("status-success")).toBeTruthy();
    expect(q.getByTestId("status-running")).toBeTruthy();

    // Status lives in the right-most <td> of its row.
    const successPillCell = (q.getByTestId("status-success").closest("td") as HTMLElement) ?? null;
    expect(successPillCell).toBeTruthy();
    const successRowCells = Array.from(successPillCell!.parentElement!.children);
    expect(successRowCells.indexOf(successPillCell!)).toBe(successRowCells.length - 1);
  });

  it("omits the workflow badge when the row has no workflow", async () => {
    const rows: PipelineSummary[] = [
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
    const api = makeClient({ listPipelines: async () => rows });
    const { container } = mount(api);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("pipelines-table")).toBeTruthy();
    });

    // The workflow cell exists (the <td> is always rendered for alignment)
    // but it contains no muted-badge span. Assert via data-variant rather
    // than a Tailwind class name (SKILL.md § Color: "theme tokens only").
    const titleLink = q.getByText("Ad-hoc run").closest("a") as HTMLElement;
    const tr = titleLink.closest("tr") as HTMLElement;
    const badgesInRow = tr.querySelectorAll('span[data-variant="muted"]');
    expect(badgesInRow.length).toBe(0);
  });

  it("shows a loading indicator while pending", async () => {
    // A promise that never resolves — guarantees we observe the loading UI.
    let _resolve: (v: PipelineSummary[]) => void = () => {};
    const pending = new Promise<PipelineSummary[]>((res) => {
      _resolve = res;
    });
    const api = makeClient({ listPipelines: () => pending });
    const { container } = mount(api);
    expect(within(container).getByTestId("pipelines-loading")).toBeTruthy();
    // Let the hanging promise resolve to empty to avoid unhandled rejections.
    _resolve([]);
  });

  it("renders a graceful empty state on failure, without leaking the raw error", async () => {
    // Silence the expected console.warn so test output stays clean.
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const api = makeClient({
        listPipelines: async () => {
          throw new Error("nope-should-not-render");
        },
      });
      const { container } = mount(api);
      await waitFor(() => {
        expect(within(container).getByTestId("pipelines-error")).toBeTruthy();
      });
      // Header still renders — no crash.
      expect(within(container).getByRole("heading", { name: "Pipelines" })).toBeTruthy();
      // Raw error message must NOT be surfaced to the user.
      expect(container.textContent ?? "").not.toContain("nope-should-not-render");
    } finally {
      console.warn = origWarn;
    }
  });
});
