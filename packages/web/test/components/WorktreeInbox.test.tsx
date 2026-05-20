// WorktreeInbox + WorktreeInboxRow — behaviour tests.
//
// Covers: list rendering, empty state, one happy-path action (commit),
// and one refusal (merge 409 merge_conflict).
//
// Uses the real stat shape: { filesChanged, insertions, deletions }.
// Do NOT drift to { files, additions, deletions } — that divergence
// caused a real bug in the past.

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { WorktreeInbox } from "../../src/components/WorktreeInbox.tsx";
import type { RunSummary } from "../../src/lib/api.ts";
import { installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

// ── Fixtures ──────────────────────────────────────────────────────────

const PENDING_ROW_1: RunSummary = {
  runId: "run-aaa",
  startedAt: "2024-01-01T00:00:00Z",
  status: "success",
  runStatus: "completed",
  eventCount: 10,
  costUsd: 0.01,
  inputTokens: 100,
  outputTokens: 50,
  title: "Fix the widget",
  inboxStatus: "pending",
  changeStat: {
    committed: { filesChanged: 2, insertions: 12, deletions: 3 },
    uncommitted: null,
  },
};

const PENDING_ROW_2: RunSummary = {
  runId: "run-bbb",
  startedAt: "2024-01-02T00:00:00Z",
  status: "fail",
  runStatus: "halted",
  eventCount: 5,
  costUsd: 0.005,
  inputTokens: 40,
  outputTokens: 20,
  title: "Add tests",
  inboxStatus: "pending",
  changeStat: {
    committed: null,
    uncommitted: { filesChanged: 1, insertions: 4, deletions: 0 },
  },
};

// URL produced by listRuns({ inbox: "pending", order: "oldest" })
// order param is set before inbox in listRuns, so order comes first.
const INBOX_URL = "/api/runs?order=oldest&inbox=pending";
const COMMIT_URL = "/api/runs/run-aaa/commit";
const MERGE_URL = "/api/runs/run-bbb/merge";

function renderInbox(mocks: Record<string, () => Response | Promise<Response>>) {
  const { restore, calls } = installFetchMock(mocks);
  const result = renderWithClient(
    <MemoryRouter>
      <WorktreeInbox />
    </MemoryRouter>,
  );
  return { ...result, restore, calls };
}

// ── All tests under one useDom() to avoid DOM setup issues ───────────

describe("WorktreeInbox", () => {
  useDom();
  afterEach(() => cleanup());

  // ── Listing ────────────────────────────────────────────────────────

  describe("listing", () => {
    test("renders one row per pending run from GET /runs?inbox=pending&order=oldest", async () => {
      const { container, restore } = renderInbox({
        [INBOX_URL]: () => json([PENDING_ROW_1, PENDING_ROW_2]),
      });
      try {
        await waitFor(() => {
          expect(container.textContent).toContain("Fix the widget");
          expect(container.textContent).toContain("Add tests");
        });

        expect(container.querySelector(`[data-testid="worktree-inbox-row-run-aaa"]`)).not.toBeNull();
        expect(container.querySelector(`[data-testid="worktree-inbox-row-run-bbb"]`)).not.toBeNull();
      } finally {
        restore();
      }
    });

    test("renders change-stat badge with real shape: filesChanged / insertions / deletions", async () => {
      const { container, restore } = renderInbox({
        [INBOX_URL]: () => json([PENDING_ROW_1]),
      });
      try {
        const badge = await waitFor(() => {
          const el = container.querySelector(`[data-testid="worktree-inbox-stat-run-aaa"]`);
          if (!el) throw new Error("stat badge not found");
          return el;
        });
        // filesChanged=2, insertions=12, deletions=3
        expect(badge.textContent).toContain("2");
        expect(badge.textContent).toContain("+12");
        expect(badge.textContent).toContain("−3");
      } finally {
        restore();
      }
    });

    test("falls back to uncommitted stat when committed is null (run-bbb)", async () => {
      const { container, restore } = renderInbox({
        [INBOX_URL]: () => json([PENDING_ROW_2]),
      });
      try {
        const badge = await waitFor(() => {
          const el = container.querySelector(`[data-testid="worktree-inbox-stat-run-bbb"]`);
          if (!el) throw new Error("stat badge not found");
          return el;
        });
        // uncommitted: filesChanged=1, insertions=4, deletions=0
        expect(badge.textContent).toContain("1");
        expect(badge.textContent).toContain("+4");
      } finally {
        restore();
      }
    });

    test("renders an empty state when the inbox query returns []", async () => {
      const { container, restore } = renderInbox({
        [INBOX_URL]: () => json([]),
      });
      try {
        await waitFor(() => {
          const el = container.querySelector(`[data-testid="worktree-inbox-empty"]`);
          if (!el) throw new Error("empty state not found");
          return el;
        });
      } finally {
        restore();
      }
    });
  });

  // ── Happy-path action: Commit ───────────────────────────────────────

  describe("happy-path action (commit)", () => {
    test("POSTs commit message and invalidates inbox so the row disappears on refetch", async () => {
      let serveList: RunSummary[] = [PENDING_ROW_1];

      const mocks: Record<string, () => Response | Promise<Response>> = {
        [INBOX_URL]: () => json(serveList),
        [COMMIT_URL]: () => {
          serveList = [];
          return json({ seq: 1 });
        },
      };

      const { container, restore, calls } = renderInbox(mocks);
      try {
        // Wait for the row to appear
        await waitFor(() => {
          if (!container.querySelector(`[data-testid="worktree-inbox-row-run-aaa"]`)) {
            throw new Error("row not yet rendered");
          }
        });

        // Open the commit popover
        const commitBtn = container.querySelector(
          `[data-testid="worktree-commit-btn-run-aaa"]`,
        ) as HTMLButtonElement | null;
        expect(commitBtn).not.toBeNull();
        fireEvent.click(commitBtn!);

        // Fill commit message (inline form, same container)
        const msgInput = await waitFor(() => {
          const el = container.querySelector(`[data-testid="commit-message-input"]`) as HTMLInputElement | null;
          if (!el) throw new Error("commit message input not found");
          return el;
        });
        fireEvent.change(msgInput, { target: { value: "feat: implement widget" } });

        // Submit via form submit (fireEvent.click on type=submit doesn't
        // trigger onSubmit in happy-dom; submit the form directly)
        const form = container.querySelector(`[data-testid="commit-form"]`) as HTMLFormElement | null;
        expect(form).not.toBeNull();
        fireEvent.submit(form!);

        // The POST should have been called
        await waitFor(() => {
          const posted = calls.find((c) => c.url === COMMIT_URL && c.method === "POST");
          if (!posted) throw new Error("POST /commit not called");
          return posted;
        });

        // After invalidation the row should disappear (serveList is now [])
        await waitFor(() => {
          if (container.querySelector(`[data-testid="worktree-inbox-row-run-aaa"]`)) {
            throw new Error("row still present after action");
          }
        });
      } finally {
        restore();
      }
    });
  });

  // ── Refusal surface: Merge 409 ──────────────────────────────────────

  describe("refusal surface (merge 409)", () => {
    test("shows the server error message inline when /merge returns 409 merge_conflict", async () => {
      const { container, restore } = renderInbox({
        [INBOX_URL]: () => json([PENDING_ROW_2]),
        [MERGE_URL]: () =>
          new Response(JSON.stringify({ error: "merge conflict detected", code: "merge_conflict" }), {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
      });
      try {
        // Wait for the row
        await waitFor(() => {
          if (!container.querySelector(`[data-testid="worktree-inbox-row-run-bbb"]`)) {
            throw new Error("row not yet rendered");
          }
        });

        // Open the merge popover
        const mergeBtn = container.querySelector(
          `[data-testid="worktree-merge-btn-run-bbb"]`,
        ) as HTMLButtonElement | null;
        expect(mergeBtn).not.toBeNull();
        fireEvent.click(mergeBtn!);

        // Submit (ff is the default — inline form)
        const submitBtn = await waitFor(() => {
          const el = container.querySelector(`[data-testid="merge-submit-btn"]`) as HTMLButtonElement | null;
          if (!el) throw new Error("merge submit button not found");
          return el;
        });
        fireEvent.click(submitBtn);

        // The error message from the server body should appear inline
        await waitFor(() => {
          const errorEl = container.querySelector(`[data-testid="worktree-action-error"]`);
          if (!errorEl) throw new Error("error message not found");
          if (!errorEl.textContent?.includes("merge conflict detected")) {
            throw new Error(`unexpected error text: ${errorEl.textContent}`);
          }
          return errorEl;
        });
      } finally {
        restore();
      }
    });
  });
});
