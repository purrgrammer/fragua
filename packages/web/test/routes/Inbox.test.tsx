// /inbox route — unified two-section layout tests.
//
// Covers:
//  - Both sections render ("Needs input" before "Ready to land")
//  - Combined empty state when both are empty
//  - Per-section empty state when only one side has data

import { cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test } from "vitest";
import type { RunSummary } from "../../src/lib/api.ts";
import { InboxPage } from "../../src/routes/Inbox.tsx";
import { installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";

// ── Query URLs ────────────────────────────────────────────────────────
// Must exactly match what listRuns() builds for each filter.
// listRuns adds params in order: status, order, limit, cwd, inbox.
// statuses are sorted alphabetically before joining.
const BLOCKED_URL = "/api/runs?status=paused%2Cpaused_human%2Cquarantined&order=oldest";
const WORKTREE_URL = "/api/runs?order=oldest&inbox=pending";

// ── Fixtures ──────────────────────────────────────────────────────────

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

function renderPage(mocks: Record<string, () => Response | Promise<Response>>) {
  const { restore } = installFetchMock(mocks);
  const result = renderWithClient(
    <MemoryRouter>
      <InboxPage />
    </MemoryRouter>,
  );
  return { ...result, restore };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("InboxPage", () => {
  afterEach(() => cleanup());

  describe("two-section layout", () => {
    test("renders 'Needs input' section before 'Ready to land' section when both have data", async () => {
      const { container, restore } = renderPage({
        [BLOCKED_URL]: () => json([blockedRun("b1")]),
        [WORKTREE_URL]: () => json([pendingRun("w1")]),
      });
      try {
        await waitFor(() => {
          if (!container.querySelector('[data-testid="inbox-needs-input"]')) {
            throw new Error("inbox-needs-input section not found");
          }
          if (!container.querySelector('[data-testid="worktree-inbox"]')) {
            throw new Error("worktree-inbox section not found");
          }
        });

        // DOM order: Needs input must appear before Ready to land.
        const sections = container.querySelectorAll("[data-testid]");
        const ids = Array.from(sections).map((el) => el.getAttribute("data-testid"));
        const needsIdx = ids.indexOf("inbox-needs-input");
        const landIdx = ids.indexOf("worktree-inbox");
        expect(needsIdx).toBeGreaterThanOrEqual(0);
        expect(landIdx).toBeGreaterThanOrEqual(0);
        expect(needsIdx).toBeLessThan(landIdx);
      } finally {
        restore();
      }
    });

    test("renders a single combined empty state when both sections are empty", async () => {
      const { container, restore } = renderPage({
        [BLOCKED_URL]: () => json([]),
        [WORKTREE_URL]: () => json([]),
      });
      try {
        await waitFor(() => {
          const el = container.querySelector('[data-testid="inbox-empty-combined"]');
          if (!el) throw new Error("combined empty state not found");
          return el;
        });
        // Neither per-section empty state should be rendered.
        expect(container.querySelector('[data-testid="inbox-empty"]')).toBeNull();
        expect(container.querySelector('[data-testid="worktree-inbox-empty"]')).toBeNull();
      } finally {
        restore();
      }
    });

    test("shows worktree-inbox per-section empty when only blocked section has data", async () => {
      const { container, restore } = renderPage({
        [BLOCKED_URL]: () => json([blockedRun("b1")]),
        [WORKTREE_URL]: () => json([]),
      });
      try {
        await waitFor(() => {
          const el = container.querySelector('[data-testid="worktree-inbox-empty"]');
          if (!el) throw new Error("worktree-inbox-empty not found");
          return el;
        });
        // Combined empty state must NOT show when only one side is empty.
        expect(container.querySelector('[data-testid="inbox-empty-combined"]')).toBeNull();
      } finally {
        restore();
      }
    });

    test("shows inbox per-section empty when only worktree section has data", async () => {
      const { container, restore } = renderPage({
        [BLOCKED_URL]: () => json([]),
        [WORKTREE_URL]: () => json([pendingRun("w1")]),
      });
      try {
        await waitFor(() => {
          // The blocked-runs section's own empty state is keyed "inbox-empty"
          // (default testId from the Inbox component).
          const el = container.querySelector('[data-testid="inbox-empty"]');
          if (!el) throw new Error("inbox-empty not found");
          return el;
        });
        expect(container.querySelector('[data-testid="inbox-empty-combined"]')).toBeNull();
      } finally {
        restore();
      }
    });
  });
});
