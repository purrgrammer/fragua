// Route-level tests for Home — the dashboard landing.
//
// We seed the react-query cache directly with `setQueryData` so the
// render path (cache → reducer → projections) runs without any network
// round-trip. A `never`-resolving fetch is installed when we need to
// observe the loading-skeleton state.

import { cleanup, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, test } from "vitest";
import type { RunSummary } from "../../src/lib/api.ts";
import { queries } from "../../src/lib/queries.ts";
import { createRoutes } from "../../src/lib/router.tsx";
import { createTestQueryClient, installFetchMock, renderWithClient } from "../helpers/with-query-client.tsx";

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
    ...(overrides.runStatus !== undefined ? { runStatus: overrides.runStatus } : {}),
    ...(overrides.inboxStatus !== undefined ? { inboxStatus: overrides.inboxStatus } : {}),
    ...(overrides.changeStat !== undefined ? { changeStat: overrides.changeStat } : {}),
    ...(overrides.baseGitRef !== undefined ? { baseGitRef: overrides.baseGitRef } : {}),
  };
}

function mount(client = createTestQueryClient(), path = "/") {
  const router = createMemoryRouter(createRoutes(), { initialEntries: [path] });
  return renderWithClient(<RouterProvider router={router} />, { client });
}

/** Seed the per-section caches the way the server would respond.
 * Stats uses the unfiltered list; Running, Inbox (blocked), and worktree
 * (pending) use narrowed queries. */
function withRows(rows: RunSummary[]) {
  const client = createTestQueryClient();
  client.setQueryData(queries.runs.list().queryKey, rows);
  client.setQueryData(
    queries.runs.list({ status: ["running"] }).queryKey,
    rows.filter((r) => r.status === "running"),
  );
  const blockedRows = rows.filter(
    (r) => r.runStatus === "paused_human" || r.runStatus === "paused" || r.runStatus === "quarantined",
  );
  client.setQueryData(
    queries.runs.list({
      status: ["paused_human", "paused", "quarantined"],
      order: "oldest",
    }).queryKey,
    blockedRows,
  );
  const worktreeRows = rows.filter((r) => r.inboxStatus === "pending");
  client.setQueryData(
    queries.runs.list({
      inbox: "pending",
      order: "oldest",
    }).queryKey,
    worktreeRows,
  );
  return client;
}

// Single top-level DOM registration shared across every describe in
// this file. Registering in each nested block would race the previous
// block's async afterAll teardown.

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
      expect(q.getByTestId("tile-runs")).toBeTruthy();
    });
    // Runs tile shows TOTAL runs (3) — Analytics and Control Center
    // share the same definition of "Runs".
    expect(q.getByTestId("tile-runs").textContent).toContain("3");
    expect(q.getByTestId("tile-spend").textContent).toMatch(/\$0\.16/);
    // billed = input(155) + output(80) + cacheRead(400) + cacheWrite(40) = 675.
    expect(q.getByTestId("tile-tokens").textContent).toContain("675");
    expect(q.getByTestId("tile-cache")).toBeTruthy();
  });

  it("Runs tile counts every run (not just the currently-running ones)", async () => {
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
      expect(q.getByTestId("tile-runs")).toBeTruthy();
    });
    expect(q.getByTestId("tile-runs").textContent).toContain("9");

    // Queued tile was removed; other removed tiles are also absent.
    expect(q.queryByTestId("tile-queued")).toBeNull();
    expect(q.queryByTestId("tile-paused")).toBeNull();
    expect(q.queryByTestId("tile-total")).toBeNull();
    expect(q.queryByTestId("tile-running")).toBeNull();
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
  it("renders '—' (not Skeleton) for absent totalCostUsd + billedTokens once loaded", async () => {
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

  // ── Unified Watchtower inbox ─────────────────────────────────────────

  describe("Home — unified Watchtower inbox", () => {
    test("renders a single 'inbox' section combining blocked and worktree rows", async () => {
      const blockedRun = row({
        runId: "blocked-1",
        status: "paused",
        runStatus: "paused_human",
        startedAt: "2024-01-01T00:00:00Z",
        title: "Blocked run",
      });
      const worktreeRun = row({
        runId: "worktree-1",
        status: "success",
        runStatus: "completed",
        startedAt: "2024-01-02T00:00:00Z",
        title: "Worktree run",
        inboxStatus: "pending",
        changeStat: {
          committed: { filesChanged: 1, insertions: 5, deletions: 2 },
          uncommitted: null,
        },
      });
      const client = withRows([blockedRun, worktreeRun]);
      const { container } = mount(client);
      const q = within(container);

      await waitFor(() => {
        expect(q.getByTestId("inbox")).toBeTruthy();
      });

      // There is exactly one inbox section
      expect(container.querySelectorAll(`[data-testid="inbox"]`).length).toBe(1);

      // Both row types should be inside the one section
      const inbox = q.getByTestId("inbox");
      await waitFor(() => {
        expect(within(inbox).getByTestId(`inbox-run-blocked-1`)).toBeTruthy();
      });
      expect(within(inbox).getByTestId(`worktree-inbox-row-worktree-1`)).toBeTruthy();
    });

    test("renders ONE empty state when both lists are empty", async () => {
      const client = withRows([]);
      const { container } = mount(client);
      const q = within(container);

      await waitFor(() => {
        expect(q.getByTestId("inbox-empty")).toBeTruthy();
      });

      // Only one empty state for the unified inbox
      expect(container.querySelectorAll(`[data-testid="inbox-empty"]`).length).toBe(1);
      // The legacy separate worktree empty state must NOT appear on Home
      expect(q.queryByTestId("worktree-inbox-empty")).toBeNull();
    });

    test("does not render a separate 'Ready to land' section on Watchtower", async () => {
      const client = withRows([]);
      const { container } = mount(client);
      await waitFor(() => {
        expect(container.querySelector(`[data-testid="inbox"]`)).toBeTruthy();
      });
      // The WorktreeInbox standalone section must not appear on Home
      expect(container.querySelector(`[data-testid="worktree-inbox"]`)).toBeNull();
      // The text "Ready to land" must not appear on Home
      expect(container.textContent).not.toContain("Ready to land");
    });

    test("orders blocked rows before worktree rows, matching the /inbox detail page", async () => {
      // Worktree rows are OLDER (would win a global oldest-first sort) — but
      // the Watchtower must still surface blocked ("needs input") first, then
      // worktree ("ready to land"), matching the /inbox detail order.
      const olderWorktreeRun = row({
        runId: "worktree-old",
        status: "success",
        runStatus: "completed",
        startedAt: "2024-01-01T00:00:00Z",
        inboxStatus: "pending",
        changeStat: { committed: null, uncommitted: { filesChanged: 1, insertions: 1, deletions: 0 } },
      });
      const newerBlockedRun = row({
        runId: "blocked-new",
        status: "paused",
        runStatus: "paused_human",
        startedAt: "2024-02-01T00:00:00Z",
      });
      const client = withRows([olderWorktreeRun, newerBlockedRun]);
      const { container } = mount(client);
      const q = within(container);

      await waitFor(() => {
        expect(q.getByTestId("inbox-list")).toBeTruthy();
      });

      const list = q.getByTestId("inbox-list");
      const blockedEl = within(list).getByTestId("inbox-run-blocked-new");
      const worktreeEl = within(list).getByTestId("worktree-inbox-row-worktree-old");
      // DOCUMENT_POSITION_FOLLOWING == 4 → blocked is before worktree in DOM order.
      expect(blockedEl.compareDocumentPosition(worktreeEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    test("shows the combined count badge when there are items in either list", async () => {
      const blockedRun = row({
        runId: "blocked-x",
        status: "paused",
        runStatus: "paused",
        startedAt: "2024-01-01T00:00:00Z",
      });
      const worktreeRun = row({
        runId: "worktree-x",
        status: "success",
        runStatus: "completed",
        startedAt: "2024-01-02T00:00:00Z",
        inboxStatus: "pending",
        changeStat: { committed: null, uncommitted: { filesChanged: 1, insertions: 1, deletions: 0 } },
      });
      const client = withRows([blockedRun, worktreeRun]);
      const { container } = mount(client);

      await waitFor(() => {
        const badge = container.querySelector(`[data-testid="inbox-count-badge"]`);
        if (!badge) throw new Error("count badge not found");
        return badge;
      });

      const badge = container.querySelector(`[data-testid="inbox-count-badge"]`);
      expect(badge?.textContent?.trim()).toBe("2");
    });
  });
});
