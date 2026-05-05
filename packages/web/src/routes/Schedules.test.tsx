import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { useDom } from "../../test/setup.ts";
import { Schedules } from "./Schedules.tsx";

interface FetchCall {
  url: string;
  method: string;
}

interface StubOpts {
  schedules?: unknown[];
}

function installFetch(opts: StubOpts = {}): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const method =
      (init?.method ??
        (typeof input === "object" && "method" in (input as Request) ? (input as Request).method : "GET")) ||
      "GET";
    calls.push({ url, method });
    // GET /schedules
    if (method === "GET" && url.endsWith("/api/schedules")) {
      return new Response(JSON.stringify(opts.schedules ?? []), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // DELETE /schedules/:id
    const dm = url.match(/\/api\/schedules\/([^/?]+)$/);
    if (method === "DELETE" && dm) {
      return new Response(JSON.stringify({ deleted: decodeURIComponent(dm[1]!) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // POST /schedules/:id/{pause,resume}
    if (method === "POST" && /\/api\/schedules\/[^/]+\/(pause|resume)/.test(url)) {
      return new Response(JSON.stringify(makeSchedule({ id: "sch_test" })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };
  globalThis.fetch = mock(stub) as unknown as typeof fetch;
  return { calls };
}

function makeSchedule(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "sch_active",
    workflowRef: "ci-gate",
    cwd: "/Users/dev/repo",
    intervalMs: 60 * 60 * 1000,
    intervalText: "1h",
    input: null,
    overlapPolicy: "skip",
    nextFireAt: Date.now() + 60_000,
    lastFireAt: Date.now() - 60_000,
    lastRunId: "run_last",
    pausedAt: null,
    createdAt: Date.now() - 86_400_000,
    recentRuns: [],
    ...overrides,
  };
}

function renderWithClient(ui: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("Schedules", () => {
  useDom();
  afterEach(() => cleanup());

  // ── empty state ──
  test("renders the empty state when GET /schedules returns []", async () => {
    installFetch({ schedules: [] });
    const { container } = renderWithClient(<Schedules />);
    const empty = await waitFor(() => within(container).getByTestId("schedules-empty"));
    expect(empty).toBeTruthy();
  });

  // ── populated list ──
  test("renders one row per schedule with status pill reflecting active vs paused (pausedAt) and a 10-cell health stripe with green/red cells matching recentRuns status", async () => {
    const recent = [
      { runId: "r1", status: "completed", enqueuedAt: 1 },
      { runId: "r2", status: "completed", enqueuedAt: 2 },
      { runId: "r3", status: "completed", enqueuedAt: 3 },
      { runId: "r4", status: "halted", enqueuedAt: 4 },
      { runId: "r5", status: "cancelled", enqueuedAt: 5 },
    ];
    const active = makeSchedule({ id: "sch_active", pausedAt: null, recentRuns: recent });
    const paused = makeSchedule({
      id: "sch_paused",
      pausedAt: Date.now(),
      recentRuns: [],
      workflowRef: "nightly",
    });
    installFetch({ schedules: [active, paused] });

    const { container } = renderWithClient(<Schedules />);

    const activeRow = await waitFor(() => within(container).getByTestId("schedule-row-sch_active"));
    const pausedRow = within(container).getByTestId("schedule-row-sch_paused");

    // Status pill — one per row, the active variant lives inside the
    // active row and the paused variant inside the paused row.
    expect(within(activeRow).getByTestId("schedule-status-active")).toBeTruthy();
    expect(within(activeRow).getByTestId("schedule-status-active").getAttribute("data-status")).toBe("active");
    expect(within(pausedRow).getByTestId("schedule-status-paused")).toBeTruthy();
    expect(within(pausedRow).getByTestId("schedule-status-paused").getAttribute("data-status")).toBe("paused");

    // Health stripe — five real cells in the active row (3 success, 2 error).
    const stripe = within(activeRow).getByTestId("schedule-health-stripe");
    const realCells = stripe.querySelectorAll('[data-tone="success"], [data-tone="error"], [data-tone="neutral"]');
    expect(realCells.length).toBe(5);
    const successCount = stripe.querySelectorAll('[data-tone="success"]').length;
    const errorCount = stripe.querySelectorAll('[data-tone="error"]').length;
    expect(successCount).toBe(3);
    expect(errorCount).toBe(2);

    // Pause shows on active rows; Resume on paused rows.
    expect(within(activeRow).getByTestId("schedule-pause-sch_active")).toBeTruthy();
    expect(within(pausedRow).getByTestId("schedule-resume-sch_paused")).toBeTruthy();
  });

  // ── two-click delete confirmation ──
  test("first click on the delete button flips it to a 'Confirm delete' state without calling DELETE; a second click within the window calls DELETE /schedules/:id once", async () => {
    const sched = makeSchedule({ id: "sch_doomed", pausedAt: null });
    const { calls } = installFetch({ schedules: [sched] });

    const { container } = renderWithClient(<Schedules />);
    const btn = await waitFor(() => within(container).getByTestId("schedule-delete-sch_doomed") as HTMLButtonElement);

    // First click: confirming, no DELETE.
    expect(btn.getAttribute("data-confirming")).toBe("false");
    expect(btn.textContent).toContain("Delete");
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(btn.getAttribute("data-confirming")).toBe("true");
    expect(btn.textContent).toContain("Confirm delete");
    expect(calls.filter((c) => c.method === "DELETE" && c.url.includes("/schedules/sch_doomed")).length).toBe(0);

    // Second click within the window: DELETE fires exactly once.
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      const deletes = calls.filter((c) => c.method === "DELETE" && c.url.includes("/schedules/sch_doomed"));
      expect(deletes.length).toBe(1);
    });
  });
});
