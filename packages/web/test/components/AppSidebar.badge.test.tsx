// AppSidebar — Inbox pending-count badge.
//
// Verifies the badge appears next to the Inbox nav row when there are
// pending worktree-inbox runs, and is absent when the inbox is empty.

import { cleanup, render, waitFor } from "@testing-library/react";
import { createMemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test } from "vitest";
import { App } from "../../src/App.tsx";
import type { RunSummary } from "../../src/lib/api.ts";
import { createRoutes } from "../../src/lib/router.tsx";
import { createTestQueryClient, installFetchMock, json } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

function blockedRun(id: string): RunSummary {
  return {
    runId: id,
    startedAt: "2024-01-01T00:00:00Z",
    status: "paused",
    runStatus: "paused",
    eventCount: 2,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function pendingRun(id: string): RunSummary {
  return {
    runId: id,
    startedAt: "2024-01-01T00:00:00Z",
    status: "success",
    runStatus: "completed",
    eventCount: 1,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    inboxStatus: "pending",
    changeStat: {
      committed: { filesChanged: 1, insertions: 2, deletions: 0 },
      uncommitted: null,
    },
  };
}

function mountApp(mocks: Record<string, () => Response | Promise<Response>>, path = "/inbox") {
  const router = createMemoryRouter(createRoutes(), { initialEntries: [path] });
  const fetchMock = installFetchMock(
    mocks,
    () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const queryClient = createTestQueryClient();
  const result = render(<App router={router} queryClient={queryClient} />);
  return { ...result, fetchMock };
}

// URL produced by listRuns({ inbox: "pending", order: "oldest" })
const WORKTREE_URL = "/api/runs?order=oldest&inbox=pending";
// URL produced by listRuns({ status: ["paused_human", "paused", "quarantined"], order: "oldest" })
// listRuns adds status first, then order; statuses sorted alphabetically.
const BLOCKED_URL = "/api/runs?status=paused%2Cpaused_human%2Cquarantined&order=oldest";
const HEALTH_URL = "/api/health";

describe("AppSidebar — Inbox pending-count badge", () => {
  useDom();
  afterEach(() => cleanup());

  test("renders worktree-pending count when only worktree runs are pending", async () => {
    const rows = [pendingRun("run-1"), pendingRun("run-2"), pendingRun("run-3")];
    const { container, fetchMock } = mountApp({
      [HEALTH_URL]: () =>
        json({
          ok: true,
          daemon: {
            pid: 1,
            port: 6767,
            startedAt: "2024-01-01T00:00:00Z",
            version: "0.0.0",
            concurrency: 4,
            inflight: 0,
            queued: 0,
          },
        }),
      [WORKTREE_URL]: () => json(rows),
      [BLOCKED_URL]: () => json([]),
    });
    try {
      await waitFor(() => {
        const badge = container.querySelector('[data-testid="nav-inbox-pending-count"]');
        if (!badge) throw new Error("badge not found");
        if (badge.textContent !== "3") throw new Error(`expected "3", got "${badge.textContent}"`);
      });
    } finally {
      fetchMock.restore();
    }
  });

  test("badge count is blocked + worktree-pending combined", async () => {
    const { container, fetchMock } = mountApp({
      [HEALTH_URL]: () => json({ ok: true }),
      [BLOCKED_URL]: () => json([blockedRun("b1"), blockedRun("b2")]),
      [WORKTREE_URL]: () => json([pendingRun("w1"), pendingRun("w2"), pendingRun("w3")]),
    });
    try {
      await waitFor(() => {
        const badge = container.querySelector('[data-testid="nav-inbox-pending-count"]');
        if (!badge) throw new Error("badge not found");
        // 2 blocked + 3 worktree = 5
        if (badge.textContent !== "5") throw new Error(`expected "5", got "${badge.textContent}"`);
      });
    } finally {
      fetchMock.restore();
    }
  });

  test("renders no badge when both inbox sections are empty", async () => {
    const { container, fetchMock } = mountApp({
      [HEALTH_URL]: () => json({ ok: true }),
      [WORKTREE_URL]: () => json([]),
      [BLOCKED_URL]: () => json([]),
    });
    try {
      // Give queries time to resolve — the combined empty state should appear.
      await waitFor(() => {
        const section = container.querySelector('[data-testid="inbox-empty-combined"]');
        if (!section) throw new Error("inbox-empty-combined not found");
      });
      const badge = container.querySelector('[data-testid="nav-inbox-pending-count"]');
      expect(badge).toBeNull();
    } finally {
      fetchMock.restore();
    }
  });
});
