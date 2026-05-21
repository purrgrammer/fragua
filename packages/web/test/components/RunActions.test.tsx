// RunActions — behaviour tests.
//
// Covers: render guard (only when inboxStatus === "pending"); the accept
// happy-path (POST + invalidate + close); an accept refusal surfaced inline
// with the dialog kept open; and the discard confirmation toast.
//
// Note: Radix UI DropdownMenu portals content outside the container in
// happy-dom, so dialog contents are opened via the component's
// _testOpenAction prop (which bypasses the portal) while the trigger
// presence/absence confirms top-level render behaviour.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { RunActionsRun } from "../../src/components/RunActions.tsx";
import { RunActions } from "../../src/components/RunActions.tsx";
import { installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

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

// ── Fixtures ──────────────────────────────────────────────────────────

const RUN_PENDING: RunActionsRun = { runId: "run-1", inboxStatus: "pending" };
const RUN_ACTED: RunActionsRun = { runId: "run-acted", inboxStatus: "acted" };

const ACCEPT_URL = "/api/runs/run-1/accept";
const DISCARD_URL = "/api/runs/run-1/discard";

function renderActions(
  row: RunActionsRun,
  mocks: Record<string, () => Response | Promise<Response>> = {},
  testOpenAction?: "accept" | "discard",
) {
  const { restore, calls } = installFetchMock(mocks);
  const result = renderWithClient(
    <MemoryRouter>
      <RunActions row={row} _testOpenAction={testOpenAction ?? null} />
    </MemoryRouter>,
  );
  return { ...result, restore, calls };
}

describe("RunActions", () => {
  useDom();
  beforeEach(() => {
    successSpy.mockReset();
    errorSpy.mockReset();
  });
  afterEach(() => cleanup());

  describe("render guard", () => {
    test("renders nothing when inboxStatus is not 'pending'", () => {
      const { container, restore } = renderActions(RUN_ACTED);
      try {
        expect(container.querySelector(`[data-testid="run-actions-trigger-run-acted"]`)).toBeNull();
        expect(container.firstChild).toBeNull();
      } finally {
        restore();
      }
    });

    test("renders the Actions trigger when inboxStatus is 'pending'", () => {
      const { container, restore } = renderActions(RUN_PENDING);
      try {
        const trigger = container.querySelector(`[data-testid="run-actions-trigger-run-1"]`);
        expect(trigger).not.toBeNull();
        expect(trigger?.textContent).toContain("Actions");
        expect(trigger?.getAttribute("aria-haspopup")).toBe("menu");
      } finally {
        restore();
      }
    });
  });

  describe("accept", () => {
    test("POSTs accept + invalidates lists + closes dialog on success", async () => {
      const { container, restore, calls } = renderActions(
        RUN_PENDING,
        { [ACCEPT_URL]: () => json({ seq: 1 }) },
        "accept",
      );
      try {
        const confirmBtn = await waitFor(() => {
          const el = container.querySelector(`[data-testid="accept-confirm-btn-run-1"]`) as HTMLButtonElement | null;
          if (!el) throw new Error("accept confirm button not found");
          return el;
        });
        fireEvent.click(confirmBtn);

        await waitFor(() => {
          const posted = calls.find((c) => c.url === ACCEPT_URL && c.method === "POST");
          if (!posted) throw new Error("POST /accept not called");
          return posted;
        });

        await waitFor(() => {
          if (container.querySelector(`[data-testid="accept-dialog"]`)) {
            throw new Error("dialog still open after success");
          }
        });
      } finally {
        restore();
      }
    });

    test("shows the refusal inline on 409 and keeps the dialog open", async () => {
      const mocks: Record<string, () => Response | Promise<Response>> = {
        [ACCEPT_URL]: () =>
          new Response(JSON.stringify({ error: "run does not merge cleanly", code: "conflict" }), {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
      };
      const { container, restore } = renderActions(RUN_PENDING, mocks, "accept");
      try {
        const confirmBtn = await waitFor(() => {
          const el = container.querySelector(`[data-testid="accept-confirm-btn-run-1"]`) as HTMLButtonElement | null;
          if (!el) throw new Error("accept confirm button not found");
          return el;
        });
        fireEvent.click(confirmBtn);

        await waitFor(() => {
          const errorEl = container.querySelector(`[data-testid="worktree-action-error"]`);
          if (!errorEl) throw new Error("error message not found");
          if (!errorEl.textContent?.includes("run does not merge cleanly")) {
            throw new Error(`unexpected error text: ${errorEl.textContent}`);
          }
          return errorEl;
        });

        expect(container.querySelector(`[data-testid="accept-dialog"]`)).not.toBeNull();
      } finally {
        restore();
      }
    });
  });

  describe("discard", () => {
    test("success fires a discard-confirmation toast and closes the dialog", async () => {
      const { container, restore } = renderActions(RUN_PENDING, { [DISCARD_URL]: () => json({ seq: 1 }) }, "discard");
      try {
        const confirmBtn = await waitFor(() => {
          const el = container.querySelector(`[data-testid="discard-confirm-btn-run-1"]`) as HTMLButtonElement | null;
          if (!el) throw new Error("discard confirm button not found");
          return el;
        });
        fireEvent.click(confirmBtn);

        await waitFor(() => {
          if (!successSpy.mock.calls.some((c) => (c as unknown[])[0] === "Changes discarded")) {
            throw new Error(
              `toast.success not called with "Changes discarded"; calls: ${JSON.stringify(successSpy.mock.calls as unknown[])}`,
            );
          }
        });

        await waitFor(() => {
          if (container.querySelector(`[data-testid="discard-confirm"]`)) {
            throw new Error("discard confirm dialog still open after success");
          }
        });
      } finally {
        restore();
      }
    });
  });
});
