// Route-level tests for PipelinesList. We mount the component inside a
// `createMemoryRouter` so `<Link>` resolves, and stub the ApiClient rather
// than `fetch` — keeps the test focused on presentation, not transport.

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
    pipelineEventsUrl: eventsUrl,
    ...overrides,
  };
}

function mount(api: ApiClient, path = "/") {
  const router = createMemoryRouter(createRoutes({ api }), { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

describe("PipelinesList", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders one row per pipeline with status and link", async () => {
    const rows: PipelineSummary[] = [
      {
        runId: "r1",
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

    // Both rows present.
    expect(q.getByText("r1")).toBeTruthy();
    expect(q.getByText("r2")).toBeTruthy();
    expect(q.getByText("wf-A")).toBeTruthy();
    expect(q.getByText("wf-B")).toBeTruthy();

    // Status pills carry their status as a data-testid.
    expect(q.getByTestId("status-success").textContent).toContain("success");
    expect(q.getByTestId("status-running").textContent).toContain("running");

    // Link targets — querySelector on the rendered anchors.
    const links = container.querySelectorAll("a[href]");
    const hrefs = Array.from(links).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/pipelines/r1");
    expect(hrefs).toContain("/pipelines/r2");
  });

  it("renders startedAt via the locale-aware helpers (no raw ISO leaks to users)", async () => {
    const rows: PipelineSummary[] = [
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
    ];
    const api = makeClient({ listPipelines: async () => rows });
    const { container } = mount(api);
    const q = within(container);

    await waitFor(() => {
      expect(q.getByTestId("pipelines-table")).toBeTruthy();
    });

    // The cell's visible text is NOT the raw ISO string.
    const cell = q.getByTestId("started-r1");
    expect(cell.textContent ?? "").not.toBe("2024-01-01T00:00:00Z");
    expect(cell.textContent ?? "").not.toContain("T00:00");
    // The precise ISO is reachable via the title attribute so operators
    // can hover for precision (and copy/paste).
    const cellEl = cell as HTMLElement;
    const row = cellEl.closest("td") as HTMLElement;
    expect(row.getAttribute("title")).toBe("2024-01-01T00:00:00.000Z");
  });

  it("renders cost and tokens in separate columns with long-form tooltips", async () => {
    const rows: PipelineSummary[] = [
      {
        runId: "rUsage",
        workflow: "wf",
        startedAt: "2024-01-01T00:00:00Z",
        status: "success",
        eventCount: 5,
        costUsd: 0.123,
        inputTokens: 3500,
        outputTokens: 700,
      },
    ];
    const api = makeClient({ listPipelines: async () => rows });
    const { container } = mount(api);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("pipelines-table")).toBeTruthy();
    });

    // Cost column: USD formatted on its own, with a tooltip repeating it
    // in long form for copy/paste.
    const costCell = q.getByTestId("cost-rUsage");
    expect((costCell.textContent ?? "").trim()).toBe("$0.123");
    const costTitle = (costCell.closest("td") as HTMLElement).getAttribute("title") ?? "";
    expect(costTitle).toContain("$0.123");

    // Tokens column: compact total, tooltip holds the input/output split.
    const tokensCell = q.getByTestId("tokens-rUsage");
    expect(tokensCell.textContent ?? "").toMatch(/4(\.2)?K/); // 3500+700 = 4200
    expect(tokensCell.textContent ?? "").not.toContain("tok"); // no unit in compact cell
    const tokensTitle = (tokensCell.closest("td") as HTMLElement).getAttribute("title") ?? "";
    expect(tokensTitle).toContain("input 3,500");
    expect(tokensTitle).toContain("output 700");
  });

  it("renders '—' in both cost and tokens cells when no LLM usage is reported", async () => {
    const rows: PipelineSummary[] = [
      {
        runId: "rEmpty",
        startedAt: "2024-01-01T00:00:00Z",
        status: "running",
        eventCount: 2,
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
    expect((q.getByTestId("cost-rEmpty").textContent ?? "").trim()).toBe("—");
    expect((q.getByTestId("tokens-rEmpty").textContent ?? "").trim()).toBe("—");
  });

  it("does not render an Events column", async () => {
    const rows: PipelineSummary[] = [
      {
        runId: "rNoEvents",
        startedAt: "2024-01-01T00:00:00Z",
        status: "success",
        eventCount: 42,
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
    const headers = Array.from(q.getByTestId("pipelines-table").querySelectorAll("thead th")).map((th) =>
      (th.textContent ?? "").trim(),
    );
    expect(headers).not.toContain("Events");
    expect(headers).toContain("Cost");
    expect(headers).toContain("Tokens");
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
      expect(within(container).getByText("Pipelines")).toBeTruthy();
      // Raw error message must NOT be surfaced to the user.
      expect(container.textContent ?? "").not.toContain("nope-should-not-render");
    } finally {
      console.warn = origWarn;
    }
  });
});
