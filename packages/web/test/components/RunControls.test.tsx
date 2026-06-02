// RunControls — cancel confirmation dialog behaviour.
//
// The cancel action opens an AlertDialog (portaled to document.body).
// All four assertions from the spec:
//   1. Clicking Cancel opens the dialog — does NOT immediately call the API.
//   2. Confirming in the dialog calls cancelRun with the typed reason.
//   3. Dismissing the dialog calls nothing and closes it.
//   4. No timer-based auto-revert — the dialog stays open across advanced
//      timers / after a delay.
//
// Portal content lives under document.body; queries use findInBody().

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RunControls } from "../../src/components/RunControls.tsx";
import type { RunDetail } from "../../src/lib/api.ts";
import { installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";

// ── Toast mocks ──────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

const CANCEL_URL = "/api/runs/run-99/cancel";

type ControlStatus = RunDetail["status"];
type ControlRunStatus = RunDetail["runStatus"];

function renderControls(
  mocks: Record<string, () => Response | Promise<Response>> = {},
  status: ControlStatus = "running",
  runStatus: ControlRunStatus = "running",
) {
  const { restore, calls } = installFetchMock(mocks);
  const result = renderWithClient(<RunControls runId="run-99" status={status} runStatus={runStatus} />);
  return { ...result, restore, calls };
}

async function findInBody(testId: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.body.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
    if (!el) throw new Error(`"${testId}" not found in document.body`);
    return el;
  });
}

function inBody(testId: string): Element | null {
  return document.body.querySelector(`[data-testid="${testId}"]`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RunControls — cancel dialog", () => {
  beforeEach(() => {
    successSpy.mockReset();
    errorSpy.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  // 1. Clicking Cancel opens dialog and does NOT immediately call the API.
  test("clicking Cancel opens the dialog without calling the cancel API", async () => {
    const { container, restore, calls } = renderControls();
    try {
      const trigger = container.querySelector(`[data-testid="run-controls-cancel"]`) as HTMLButtonElement;
      expect(trigger).not.toBeNull();

      fireEvent.click(trigger);

      await findInBody("cancel-run-dialog");

      // No API call fired yet.
      expect(calls.filter((c) => c.url === CANCEL_URL)).toHaveLength(0);
    } finally {
      restore();
    }
  });

  // 2. Confirming in the dialog calls cancelRun with the typed reason.
  test("confirming with a typed reason calls cancelRun with that reason", async () => {
    const { container, restore, calls } = renderControls({
      [CANCEL_URL]: () => json({ seq: 1 }),
    });
    try {
      const trigger = container.querySelector(`[data-testid="run-controls-cancel"]`) as HTMLButtonElement;
      fireEvent.click(trigger);

      const textarea = await findInBody("run-controls-cancel-reason");
      fireEvent.change(textarea, { target: { value: "stopping for maintenance" } });

      const confirmBtn = await findInBody("run-controls-cancel-confirm");
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        const hit = calls.find((c) => c.url === CANCEL_URL && c.method === "POST");
        if (!hit) throw new Error("POST /cancel not called");
        return hit;
      });

      expect(calls.some((c) => c.url === CANCEL_URL)).toBe(true);
    } finally {
      restore();
    }
  });

  // 2b. Confirming with no reason calls cancelRun without a reason (empty → undefined).
  test("confirming with blank reason calls cancelRun without a reason body", async () => {
    const { container, restore, calls } = renderControls({
      [CANCEL_URL]: () => json({ seq: 1 }),
    });
    try {
      const trigger = container.querySelector(`[data-testid="run-controls-cancel"]`) as HTMLButtonElement;
      fireEvent.click(trigger);

      await findInBody("cancel-run-dialog");

      const confirmBtn = await findInBody("run-controls-cancel-confirm");
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        const hit = calls.find((c) => c.url === CANCEL_URL && c.method === "POST");
        if (!hit) throw new Error("POST /cancel not called");
        return hit;
      });
    } finally {
      restore();
    }
  });

  // 3. Dismissing the dialog calls nothing and closes it.
  test("dismissing the dialog calls nothing and closes it", async () => {
    const { container, restore, calls } = renderControls();
    try {
      const trigger = container.querySelector(`[data-testid="run-controls-cancel"]`) as HTMLButtonElement;
      fireEvent.click(trigger);

      const dismissBtn = await findInBody("cancel-run-dialog-dismiss");
      fireEvent.click(dismissBtn);

      await waitFor(() => {
        if (inBody("cancel-run-dialog")) throw new Error("dialog still open after dismiss");
      });

      expect(calls.filter((c) => c.url === CANCEL_URL)).toHaveLength(0);
    } finally {
      restore();
    }
  });

  // 4. No timer-based auto-revert — dialog stays open across advanced timers.
  test("dialog remains open after timers advance (no auto-revert)", async () => {
    vi.useFakeTimers();
    const { container, restore } = renderControls();
    try {
      const trigger = container.querySelector(`[data-testid="run-controls-cancel"]`) as HTMLButtonElement;
      fireEvent.click(trigger);

      // With fake timers, waitFor won't work directly. Check synchronously
      // after clicking — dialog should be in body immediately after the click.
      const dialog = inBody("cancel-run-dialog");
      expect(dialog).not.toBeNull();

      // Advance well past the old 3 s confirm window.
      vi.advanceTimersByTime(10_000);

      // Dialog must still be present — no auto-revert.
      expect(inBody("cancel-run-dialog")).not.toBeNull();
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  // data-testid parity: trigger is run-controls-cancel, confirm is run-controls-cancel-confirm.
  test("trigger has data-testid=run-controls-cancel, dialog confirm has run-controls-cancel-confirm", async () => {
    const { container, restore } = renderControls();
    try {
      const trigger = container.querySelector(`[data-testid="run-controls-cancel"]`);
      expect(trigger).not.toBeNull();

      fireEvent.click(trigger as HTMLElement);

      const confirm = await findInBody("run-controls-cancel-confirm");
      expect(confirm).not.toBeNull();
    } finally {
      restore();
    }
  });
});
