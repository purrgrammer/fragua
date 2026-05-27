// RunControls — toast feedback tests.
//
// Verifies that pause/resume/cancel mutations fire the correct toast on
// success and error. We spy on `toast.success` and `toast.error` at the
// module boundary using `vi.mock("sonner", ...)` so the spies are in
// place before the component's module resolves its import.

import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { RunControls } from "../../src/components/RunControls.tsx";
import { installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";

const PAUSE_URL = "/api/runs/run-99/pause";
const RESUME_URL = "/api/runs/run-99/resume";
const CANCEL_URL = "/api/runs/run-99/cancel";
const DETAIL_URL = "/api/runs/run-99";
const EVENTS_URL = "/api/runs/run-99/events";

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

function renderControls(
  overrides: { status?: string; runStatus?: string } = {},
  mocks: Record<string, () => Response | Promise<Response>> = {},
) {
  const status = (overrides.status ?? "running") as
    | "running"
    | "paused"
    | "queued"
    | "success"
    | "fail"
    | "canceled"
    | "unknown";
  const runStatus = (overrides.runStatus ?? "running") as
    | "queued"
    | "running"
    | "paused"
    | "paused_human"
    | "paused_auto"
    | "completed"
    | "cancelled"
    | "halted"
    | "quarantined";
  const { restore, calls } = installFetchMock({
    [DETAIL_URL]: () => json({ runId: "run-99", status, runStatus }),
    [EVENTS_URL]: () => json({ events: [], lastSeq: 0 }),
    ...mocks,
  });
  const result = renderWithClient(
    <MemoryRouter>
      <RunControls runId="run-99" status={status} runStatus={runStatus} />
    </MemoryRouter>,
  );
  return { ...result, restore, calls };
}

describe("RunControls — toast feedback", () => {
  beforeEach(() => {
    successSpy.mockReset();
    errorSpy.mockReset();
  });

  afterEach(() => cleanup());

  test("fires toast.success('Run paused') after Pause resolves", async () => {
    const { getByTestId, restore } = renderControls(
      { status: "running", runStatus: "running" },
      {
        [PAUSE_URL]: () => json({ seq: 1 }),
      },
    );
    try {
      const pauseBtn = await waitFor(() => getByTestId("run-controls-pause") as HTMLButtonElement);
      await act(async () => {
        fireEvent.click(pauseBtn);
        await new Promise((r) => setTimeout(r, 50));
      });
      await waitFor(() => {
        if (!successSpy.mock.calls.some((c) => (c as unknown[])[0] === "Run paused")) {
          throw new Error(
            `toast.success not called with "Run paused"; calls: ${JSON.stringify(successSpy.mock.calls as unknown[])}`,
          );
        }
      });
    } finally {
      restore();
    }
  });

  test("fires toast.error when cancel fails", async () => {
    const { getByTestId, restore } = renderControls(
      { status: "running", runStatus: "running" },
      {
        [CANCEL_URL]: () =>
          new Response(JSON.stringify({ error: "nope" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      },
    );
    try {
      // Arm confirm
      const cancelBtn = await waitFor(() => getByTestId("run-controls-cancel") as HTMLButtonElement);
      await act(async () => {
        fireEvent.click(cancelBtn);
      });

      // Confirm (3 s timer armed — just click confirm directly)
      const confirmBtn = await waitFor(() => getByTestId("run-controls-cancel-confirm") as HTMLButtonElement);
      await act(async () => {
        fireEvent.click(confirmBtn);
        await new Promise((r) => setTimeout(r, 50));
      });
      await waitFor(() => {
        if (errorSpy.mock.calls.length === 0) {
          throw new Error("toast.error not called");
        }
      });
    } finally {
      restore();
    }
  });

  test("fires toast.success('Run resumed') after Resume resolves", async () => {
    const { getByTestId, restore } = renderControls(
      { status: "paused", runStatus: "paused_auto" },
      { [RESUME_URL]: () => json({ seq: 1 }) },
    );
    try {
      const resumeBtn = await waitFor(() => getByTestId("run-controls-resume") as HTMLButtonElement);
      await act(async () => {
        fireEvent.click(resumeBtn);
        await new Promise((r) => setTimeout(r, 50));
      });
      await waitFor(() => {
        if (!successSpy.mock.calls.some((c) => (c as unknown[])[0] === "Run resumed")) {
          throw new Error(
            `toast.success not called with "Run resumed"; calls: ${JSON.stringify(successSpy.mock.calls as unknown[])}`,
          );
        }
      });
    } finally {
      restore();
    }
  });
});
