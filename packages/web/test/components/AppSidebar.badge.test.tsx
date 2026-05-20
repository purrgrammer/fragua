// AppSidebar — Inbox pending-count badge.
//
// Verifies the badge appears next to the Inbox nav row when there are
// pending worktree-inbox runs, and is absent when the inbox is empty.

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createMemoryRouter } from "react-router-dom";
import { App } from "../../src/App.tsx";
import type { RunSummary } from "../../src/lib/api.ts";
import { createRoutes } from "../../src/lib/router.tsx";
import { createTestQueryClient, installFetchMock, json } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

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

// URL produced by listRuns({ inbox: "pending", order: "oldest" }):
// order param is set before inbox in listRuns, so order comes first.
const INBOX_URL = "/api/runs?order=oldest&inbox=pending";
const HEALTH_URL = "/api/health";

describe("AppSidebar — Inbox pending-count badge", () => {
  useDom();
  afterEach(() => cleanup());

  test("renders the pending count next to the Inbox nav row when GET /runs?inbox=pending returns N rows", async () => {
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
      [INBOX_URL]: () => json(rows),
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

  test("renders no badge when the inbox is empty", async () => {
    const { container, fetchMock } = mountApp({
      [HEALTH_URL]: () => json({ ok: true }),
      [INBOX_URL]: () => json([]),
    });
    try {
      // Give the query time to resolve
      await waitFor(() => {
        // The inbox section itself should render (empty state)
        const section = container.querySelector('[data-testid="worktree-inbox"]');
        if (!section) throw new Error("worktree-inbox section not found");
      });
      const badge = container.querySelector('[data-testid="nav-inbox-pending-count"]');
      expect(badge).toBeNull();
    } finally {
      fetchMock.restore();
    }
  });
});
