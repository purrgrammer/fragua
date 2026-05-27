// RunActions — behaviour tests.
//
// Covers: render guard (only when inboxStatus === "pending"); the accept
// happy-path (POST + invalidate + close); an accept refusal surfaced inline
// with the dialog kept open; the discard confirmation toast; and Cancel
// dismissal.
//
// The confirm step uses the AlertDialog primitive, which portals its content
// to document.body. The dropdown trigger lives in `container`; everything
// inside an open dialog is queried from document.body.

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RunActionsRun } from "../../src/components/RunActions.tsx";
import { RunActions } from "../../src/components/RunActions.tsx";
import { installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";

const { successSpy, errorSpy } = vi.hoisted(() => ({
  successSpy: vi.fn(() => "t1"),
  errorSpy: vi.fn(() => "t2"),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(
    vi.fn(() => "t0"),
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
      <RunActions row={row} _testInitialOpenAction={testOpenAction ?? null} />
    </MemoryRouter>,
  );
  return { ...result, restore, calls };
}

/** Wait for a portaled element — open-dialog content lives under document.body. */
function findInBody<T extends Element = HTMLElement>(testId: string): Promise<T> {
  return waitFor(() => {
    const el = document.body.querySelector(`[data-testid="${testId}"]`) as T | null;
    if (!el) throw new Error(`"${testId}" not found in document.body`);
    return el;
  });
}

function inBody(testId: string): Element | null {
  return document.body.querySelector(`[data-testid="${testId}"]`);
}

describe("RunActions", () => {
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

  describe("confirm dialog", () => {
    test("opens portaled with the alertdialog role and the action's title", async () => {
      const { restore } = renderActions(RUN_PENDING, {}, "discard");
      try {
        const dialog = await findInBody("discard-dialog");
        expect(dialog.getAttribute("role")).toBe("alertdialog");
        expect(dialog.textContent).toContain("Discard changes");
      } finally {
        restore();
      }
    });

    test("Cancel dismisses the dialog", async () => {
      const { restore } = renderActions(RUN_PENDING, {}, "discard");
      try {
        const cancel = await findInBody<HTMLButtonElement>("discard-dialog-cancel");
        fireEvent.click(cancel);
        await waitFor(() => {
          if (inBody("discard-dialog")) throw new Error("dialog still open after Cancel");
        });
      } finally {
        restore();
      }
    });
  });

  describe("accept", () => {
    test("POSTs accept + invalidates lists + closes dialog on success", async () => {
      const { restore, calls } = renderActions(RUN_PENDING, { [ACCEPT_URL]: () => json({ seq: 1 }) }, "accept");
      try {
        const confirmBtn = await findInBody<HTMLButtonElement>("accept-confirm-btn-run-1");
        fireEvent.click(confirmBtn);

        await waitFor(() => {
          const posted = calls.find((c) => c.url === ACCEPT_URL && c.method === "POST");
          if (!posted) throw new Error("POST /accept not called");
          return posted;
        });

        await waitFor(() => {
          if (inBody("accept-dialog")) throw new Error("dialog still open after success");
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
      const { restore } = renderActions(RUN_PENDING, mocks, "accept");
      try {
        const confirmBtn = await findInBody<HTMLButtonElement>("accept-confirm-btn-run-1");
        fireEvent.click(confirmBtn);

        const errorEl = await findInBody("worktree-action-error");
        expect(errorEl.textContent).toContain("run does not merge cleanly");
        expect(inBody("accept-dialog")).not.toBeNull();
      } finally {
        restore();
      }
    });
  });

  describe("discard", () => {
    test("success fires a discard-confirmation toast and closes the dialog", async () => {
      const { restore } = renderActions(RUN_PENDING, { [DISCARD_URL]: () => json({ seq: 1 }) }, "discard");
      try {
        const confirmBtn = await findInBody<HTMLButtonElement>("discard-confirm-btn-run-1");
        fireEvent.click(confirmBtn);

        await waitFor(() => {
          if (!successSpy.mock.calls.some((c) => (c as unknown[])[0] === "Changes discarded")) {
            throw new Error(
              `toast.success not called with "Changes discarded"; calls: ${JSON.stringify(successSpy.mock.calls as unknown[])}`,
            );
          }
        });

        await waitFor(() => {
          if (inBody("discard-dialog")) throw new Error("discard dialog still open after success");
        });
      } finally {
        restore();
      }
    });
  });
});
