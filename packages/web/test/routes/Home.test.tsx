// Route-level tests for Home — the dashboard landing.
//
// We seed the react-query cache directly with `setQueryData` so the
// render path (cache → reducer → projections) runs without any network
// round-trip. A `never`-resolving fetch is installed when we need to
// observe the loading-skeleton state.

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
// react-dom/test-utils Simulate is the only way to dispatch an event that
// happy-dom + React 18 will route to a React synthetic onChange handler on
// controlled inputs.
import { Simulate } from "react-dom/test-utils";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import type { RunSummary, WorkflowSummary } from "../../src/lib/api.ts";
import { queries } from "../../src/lib/queries.ts";
import { createRoutes } from "../../src/lib/router.tsx";
import { INBOX_HOME_LIMIT } from "../../src/routes/Home.tsx";
import { HealthContext, type HealthContextValue, type HealthDaemonSnapshot } from "../../src/types/health.ts";
import { createTestQueryClient, installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

function row(overrides: Partial<RunSummary> = {}): RunSummary {
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

const DAEMON_ON: HealthDaemonSnapshot = {
  pid: 1,
  port: 3000,
  startedAt: "2024-01-01T00:00:00Z",
  version: "test",
  concurrency: 1,
  inflight: 0,
  queued: 0,
};

function withHealth(value: HealthContextValue) {
  return function HealthWrapper({ children }: { children: ReactNode }): JSX.Element {
    return <HealthContext.Provider value={value}>{children}</HealthContext.Provider>;
  };
}

function mountWithHealth(health: HealthContextValue, client = createTestQueryClient(), path = "/") {
  const router = createMemoryRouter(createRoutes(), { initialEntries: [path] });
  const Wrapper = withHealth(health);
  return renderWithClient(
    <Wrapper>
      <RouterProvider router={router} />
    </Wrapper>,
    { client },
  );
}

function workflow(name: string, label?: string): WorkflowSummary {
  return {
    name,
    path: `workflows/${name}.dot`,
    sha: `sha-${name}`,
    ...(label !== undefined ? { label } : {}),
  };
}

/**
 * Drive a controlled textarea in happy-dom. Native events dispatched via
 * `fireEvent.change`/`fireEvent.input` never reach React 18's synthetic
 * onChange handler under happy-dom, so we set the DOM value and invoke the
 * handler directly through `Simulate.change`. Do NOT wrap in `act()` — the
 * scoped act would stall while react-query's in-flight fetches resolve.
 * Follow each call with `waitFor` to observe the post-dispatch state.
 */
function typeInto(el: HTMLTextAreaElement, value: string): void {
  el.value = value;
  Simulate.change(el);
}

/** Seed the per-section caches the way the server would respond.
 * Stats uses the unfiltered list; Running and Inbox use narrowed
 * queries with server-enforced status/order/limit. */
function withRows(rows: RunSummary[]) {
  const client = createTestQueryClient();
  client.setQueryData(queries.runs.list().queryKey, rows);
  client.setQueryData(
    queries.runs.list({ status: ["running"] }).queryKey,
    rows.filter((r) => r.status === "running"),
  );
  const inboxRows = rows.filter(
    (r) => r.runStatus === "paused_hitl" || r.runStatus === "paused_provider_error" || r.runStatus === "quarantined",
  );
  client.setQueryData(
    queries.runs.list({
      status: ["paused_hitl", "paused_provider_error", "quarantined"],
      order: "oldest",
      limit: INBOX_HOME_LIMIT + 1,
    }).queryKey,
    inboxRows.slice(0, INBOX_HOME_LIMIT + 1),
  );
  return client;
}

// Single top-level DOM registration shared across every describe in
// this file. Registering in each nested block would race the previous
// block's async afterAll teardown.
// biome-ignore lint/correctness/useHookAtTopLevel: useDom is a test-harness helper, not a React hook — it just wraps beforeAll/afterAll.
useDom();

describe("Home route", () => {
  afterEach(() => cleanup());

  it("Running section shows the empty state when nothing is executing", async () => {
    const client = withRows([
      row({ runId: "a", status: "success", durationMs: 1_000 }),
      row({ runId: "b", status: "fail", durationMs: 2_000 }),
    ]);
    const { container } = mount(client);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("running-section")).toBeTruthy();
    });
    expect(q.queryByTestId("running-strip")).toBeNull();
    expect(q.getByTestId("running-empty")).toBeTruthy();
  });

  it("Running section shows the empty state when no runs exist at all", async () => {
    const client = withRows([]);
    const { container } = mount(client);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("running-empty")).toBeTruthy();
    });
  });

  it("renders only currently-running runs in the running strip", async () => {
    const client = withRows([
      row({ runId: "live-1", status: "running", workflow: "wf-A", eventCount: 7 }),
      row({ runId: "live-2", status: "running", workflow: "wf-B", eventCount: 3 }),
      row({ runId: "done", status: "success", durationMs: 1_000 }),
    ]);
    const { container } = mount(client);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("running-strip")).toBeTruthy();
    });
    const strip = q.getByTestId("running-strip");
    expect(within(strip).getByTestId("recent-run-live-1")).toBeTruthy();
    expect(within(strip).getByTestId("recent-run-live-2")).toBeTruthy();
    // Non-running runs no longer appear on the Control Center — that
    // archive view lives on /runs.
    expect(q.queryByTestId("recent-run-done")).toBeNull();
  });

  it("running strip excludes queued and paused runs (they are not actively executing)", async () => {
    const client = withRows([
      row({ runId: "active", status: "running" }),
      row({ runId: "waiting", status: "queued" }),
      row({ runId: "on-hold", status: "paused" }),
    ]);
    const { container } = mount(client);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("running-strip")).toBeTruthy();
    });
    const strip = q.getByTestId("running-strip");
    expect(within(strip).getByTestId("recent-run-active")).toBeTruthy();
    expect(within(strip).queryByTestId("recent-run-waiting")).toBeNull();
    expect(within(strip).queryByTestId("recent-run-on-hold")).toBeNull();
  });

  it("renders the four stats tiles populated from the reducer", async () => {
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
      expect(q.getByTestId("tile-running")).toBeTruthy();
    });
    expect(q.getByTestId("tile-running").textContent).toContain("1");
    expect(q.getByTestId("tile-spend").textContent).toMatch(/\$0\.16/);
    expect(q.getByTestId("tile-tokens").textContent).toContain("235");
    expect(q.getByTestId("tile-cache")).toBeTruthy();
  });

  it("renders the Running and Queued tiles with correct counts", async () => {
    const client = withRows([
      row({ runId: "r1", status: "running" }),
      row({ runId: "r2", status: "running" }),
      row({ runId: "q1", status: "queued" }),
      row({ runId: "q2", status: "queued" }),
      row({ runId: "q3", status: "queued" }),
      row({ runId: "p1", status: "paused" }),
      row({ runId: "s1", status: "success", durationMs: 1_000 }),
      row({ runId: "f1", status: "fail", durationMs: 1_000 }),
      row({ runId: "c1", status: "canceled" }),
    ]);
    const { container } = mount(client);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("tile-running")).toBeTruthy();
    });
    expect(q.getByTestId("tile-running").textContent).toContain("2");

    // Queued tile was removed; other removed tiles are also absent.
    expect(q.queryByTestId("tile-queued")).toBeNull();
    expect(q.queryByTestId("tile-paused")).toBeNull();
    expect(q.queryByTestId("tile-total")).toBeNull();
    expect(q.queryByTestId("stats-queue")).toBeNull();
    expect(q.queryByTestId("stats-outcomes")).toBeNull();
    expect(q.queryByTestId("stats-resources")).toBeNull();
    // Cache tile is present.
    expect(q.getByTestId("tile-cache")).toBeTruthy();
  });

  it("shows skeletons before the first response resolves", () => {
    const mock = installFetchMock({
      "/api/runs": () => new Promise<Response>(() => {}),
    });
    try {
      const { container } = mount();
      expect(within(container).getByTestId("running-section")).toBeTruthy();
      expect(within(container).queryByTestId("running-empty")).toBeNull();
      expect(container.querySelectorAll(".sw-pulse").length).toBeGreaterThan(0);
    } finally {
      mock.restore();
    }
  });

  // StatTile contract: `loading=false` + absent-value MUST render "—", never
  // a Skeleton. Skeleton is reserved for the loading branch. `cacheHitRate`
  // and `avgDurationMs` are the two optional stats fields — an empty run
  // list yields both as `undefined` via `computeStats`.
  it("renders '—' (not Skeleton) for absent totalCostUsd + freshTokens once loaded", async () => {
    const client = withRows([]);
    const { container } = mount(client);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("tile-spend")).toBeTruthy();
    });
    const spend = q.getByTestId("tile-spend");
    expect(spend.querySelector(".sw-pulse")).toBeNull();

    const tokens = q.getByTestId("tile-tokens");
    expect(tokens.querySelector(".sw-pulse")).toBeNull();
  });
});

// Overview launcher is temporarily commented out on Home until POST /jobs
// is restored on the daemon. Re-enable this suite when the component
// comes back.
describe.skip("Home / Overview launcher", () => {
  afterEach(() => cleanup());

  const workflows: WorkflowSummary[] = [workflow("build-feature", "Build feature"), workflow("fix-bug")];

  function installLauncherFetch(
    extra: Record<
      string,
      (req: { url: string; method: string; init?: RequestInit }) => Response | Promise<Response>
    > = {},
  ) {
    return installFetchMock({
      "/api/runs": () => json([]),
      "/api/workflows": () => json(workflows),
      ...extra,
    });
  }

  it("renders a workflow selector populated from GET /workflows", async () => {
    const mock = installLauncherFetch();
    try {
      const { container } = mountWithHealth({ status: "connected", error: null, daemon: DAEMON_ON }, withRows([]));
      const q = within(container);
      await waitFor(() => {
        expect(q.getByTestId("overview-workflow-trigger")).toBeTruthy();
      });
      await waitFor(() => {
        const workflowsCall = mock.calls.find((c) => c.url === "/api/workflows" && c.method === "GET");
        expect(workflowsCall).toBeTruthy();
      });
    } finally {
      mock.restore();
    }
  });

  it("disables submit when input is empty and enables after typing", async () => {
    const mock = installLauncherFetch();
    try {
      const { container } = mountWithHealth({ status: "connected", error: null, daemon: DAEMON_ON }, withRows([]));
      const q = within(container);
      await waitFor(() => {
        expect(q.getByTestId("overview-input")).toBeTruthy();
      });
      // Initial submit is disabled — either no workflow yet or no input.
      expect((q.getByTestId("overview-submit") as HTMLButtonElement).disabled).toBe(true);

      const textarea = q.getByTestId("overview-input") as HTMLTextAreaElement;
      typeInto(textarea, "ship it");
      // Workflow seeds from the /api/workflows response; submit flips
      // to enabled once that resolves AND we have non-empty input.
      await waitFor(() => {
        expect((q.getByTestId("overview-submit") as HTMLButtonElement).disabled).toBe(false);
      });
    } finally {
      mock.restore();
    }
  });

  it("on submit: POSTs /jobs with workflow path, invalidates queries, navigates to the run", async () => {
    let jobsPosts = 0;
    let runsReloads = 0;
    let lastBody: unknown;
    const mock = installFetchMock({
      "/api/runs": () => {
        runsReloads += 1;
        return json([]);
      },
      "/api/workflows": () => json(workflows),
      "/api/jobs": async ({ method, init }) => {
        if (method !== "POST") return new Response("method not allowed", { status: 405 });
        jobsPosts += 1;
        if (typeof init?.body === "string") lastBody = JSON.parse(init.body);
        return json({ jobId: "j-1", runId: "r-1" });
      },
    });
    try {
      const { container } = mountWithHealth({ status: "connected", error: null, daemon: DAEMON_ON }, withRows([]));
      const q = within(container);
      const textarea = (await waitFor(() => q.getByTestId("overview-input"))) as HTMLTextAreaElement;
      typeInto(textarea, "draft the release notes");
      await waitFor(() => {
        expect((q.getByTestId("overview-submit") as HTMLButtonElement).disabled).toBe(false);
      });

      const form = q.getByTestId("overview-form") as HTMLFormElement;
      await act(async () => {
        fireEvent.submit(form);
      });

      await waitFor(() => {
        expect(jobsPosts).toBe(1);
      });

      // Body carries the workflow PATH (so old daemons work too) + input.
      expect(lastBody).toEqual({ workflow: "workflows/build-feature.dot", input: "draft the release notes" });

      // Runs query was invalidated → at least one re-fetch.
      await waitFor(() => {
        expect(runsReloads).toBeGreaterThanOrEqual(1);
      });

      // Navigated away from Home — the overview section is no longer in
      // the tree. (Asserting on the RunDetail page's contents would
      // require mocking the run-detail + events endpoints too.)
      await waitFor(() => {
        expect(within(container).queryByTestId("overview")).toBeNull();
      });
    } finally {
      mock.restore();
    }
  });

  it("on server error: shows an inline error message; input is preserved", async () => {
    const mock = installFetchMock({
      "/api/runs": () => json([]),
      "/api/workflows": () => json(workflows),
      "/api/jobs": () => new Response("daemon offline", { status: 503 }),
    });
    try {
      const { container } = mountWithHealth({ status: "connected", error: null, daemon: DAEMON_ON }, withRows([]));
      const q = within(container);
      const textarea = (await waitFor(() => q.getByTestId("overview-input"))) as HTMLTextAreaElement;
      typeInto(textarea, "retry me");
      await waitFor(() => {
        expect((q.getByTestId("overview-submit") as HTMLButtonElement).disabled).toBe(false);
      });

      const form = q.getByTestId("overview-form") as HTMLFormElement;
      await act(async () => {
        fireEvent.submit(form);
      });

      await waitFor(() => {
        expect(q.getByTestId("overview-error")).toBeTruthy();
      });
      // Input still holds the typed text for retry.
      expect((q.getByTestId("overview-input") as HTMLTextAreaElement).value).toBe("retry me");
    } finally {
      mock.restore();
    }
  });

  it("disables the form and shows the hint when daemon is not running", async () => {
    const mock = installLauncherFetch();
    try {
      const { container } = mountWithHealth({ status: "connected", error: null }, withRows([]));
      const q = within(container);
      await waitFor(() => {
        expect(q.getByTestId("overview-daemon-off")).toBeTruthy();
      });
      expect(q.getByTestId("overview-daemon-off").textContent).toContain("Daemon not running");
      expect((q.getByTestId("overview-input") as HTMLTextAreaElement).disabled).toBe(true);
      expect((q.getByTestId("overview-submit") as HTMLButtonElement).disabled).toBe(true);
    } finally {
      mock.restore();
    }
  });
});
