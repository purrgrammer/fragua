import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useDom } from "../../test/setup.ts";
import { encodeProjectId } from "../lib/projectId.ts";
import { Schedules } from "./Schedules.tsx";

const successSpy = mock(() => "t1");
const errorSpy = mock(() => "t2");

mock.module("sonner", () => ({
  toast: Object.assign(
    mock(() => "t0"),
    {
      success: successSpy,
      error: errorSpy,
    },
  ),
}));

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
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("Schedules", () => {
  useDom();
  beforeEach(() => {
    successSpy.mockReset();
    errorSpy.mockReset();
  });
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

  // ── delete confirmation gate ──
  // We test the only behaviour that's ours to assert here: clicking the
  // Delete trigger does NOT fire a DELETE request — confirmation is
  // gated behind an AlertDialog. The dialog open/close transition itself
  // is owned by Radix and not exercised under happy-dom (which doesn't
  // simulate the pointer/animation lifecycle the primitive needs).
  test("Delete trigger is destructive and does not fire DELETE without confirmation", async () => {
    const sched = makeSchedule({ id: "sch_doomed", pausedAt: null });
    const { calls } = installFetch({ schedules: [sched] });

    const { container } = renderWithClient(<Schedules />);
    const trigger = await waitFor(
      () => within(container).getByTestId("schedule-delete-sch_doomed") as HTMLButtonElement,
    );
    expect(trigger.getAttribute("data-variant")).toBe("destructive");
    expect(trigger.textContent).toContain("Delete");

    await act(async () => {
      fireEvent.click(trigger);
    });
    await new Promise((r) => setTimeout(r, 30));
    const deletes = calls.filter((c) => c.method === "DELETE" && c.url.includes("/schedules/sch_doomed"));
    expect(deletes.length).toBe(0);
  });

  test("renders the workflow name as a link to /workflows/:ref?cwd=… and the project basename as a link to /projects/:cwdEnc", async () => {
    const sched = makeSchedule({ id: "sch_links", workflowRef: "ci-gate", cwd: "/Users/dev/repo" });
    installFetch({ schedules: [sched] });

    const { container } = renderWithClient(<Schedules />);
    const row = await waitFor(() => within(container).getByTestId("schedule-row-sch_links"));

    const links = row.querySelectorAll("a");
    const hrefs = Array.from(links).map((a) => a.getAttribute("href") ?? "");

    const wfHref = hrefs.find((h) => h.startsWith("/workflows/"));
    expect(wfHref).toBeTruthy();
    expect(wfHref).toContain("/workflows/ci-gate");
    expect(wfHref).toContain("?cwd=");

    const projHref = hrefs.find((h) => h.startsWith("/projects/"));
    expect(projHref).toBeTruthy();
    expect(projHref).toBe(`/projects/${encodeProjectId("/Users/dev/repo")}`);
  });

  // ── Toast feedback ────────────────────────────────────────────────

  test("pause success toasts 'Schedule paused' and re-fetches the list", async () => {
    const sched = makeSchedule({ id: "sch_toast_pause", pausedAt: null });
    const { calls } = installFetch({ schedules: [sched] });

    const { container } = renderWithClient(<Schedules />);
    const pauseBtn = await waitFor(
      () => within(container).getByTestId("schedule-pause-sch_toast_pause") as HTMLButtonElement,
    );

    await act(async () => {
      fireEvent.click(pauseBtn);
      await new Promise((r) => setTimeout(r, 50));
    });

    await waitFor(() => {
      if (!successSpy.mock.calls.some((c) => (c as unknown[])[0] === "Schedule paused")) {
        throw new Error(
          `toast.success not called with "Schedule paused"; calls: ${JSON.stringify(successSpy.mock.calls)}`,
        );
      }
    });

    // list query should have been re-fetched
    const listFetches = calls.filter((c) => c.method === "GET" && c.url.endsWith("/api/schedules"));
    expect(listFetches.length).toBeGreaterThanOrEqual(2);
  });
});
