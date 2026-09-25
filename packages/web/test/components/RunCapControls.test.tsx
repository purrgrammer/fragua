// RunCapControls — behaviour tests.
//
// Covers: raising a cap (max_loops) on a running, un-paused run — proving cap
// raises are reachable outside the matching pause; the max_retries node picker
// sourced from the run's nodes; and the terminal / imported render guard.

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RunCapControlsRun } from "../../src/components/RunCapControls.tsx";
import { RunCapControls } from "../../src/components/RunCapControls.tsx";
import { installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";

const { successSpy, errorSpy } = vi.hoisted(() => ({
  successSpy: vi.fn(() => "t1"),
  errorSpy: vi.fn(() => "t2"),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(
    vi.fn(() => "t0"),
    { success: successSpy, error: errorSpy },
  ),
}));

const NODES = [
  { nodeId: "review", iteration: 0, state: "completed" },
  { nodeId: "review", iteration: 1, state: "completed" },
  { nodeId: "fix", iteration: 0, state: "running" },
] as unknown as RunCapControlsRun["nodes"];

const RUNNING: RunCapControlsRun = { status: "running", runStatus: "running", nodes: NODES };
const TERMINAL: RunCapControlsRun = { status: "success", runStatus: "completed", nodes: NODES };
const IMPORTED: RunCapControlsRun = { status: "running", runStatus: "running", imported: true, nodes: NODES };

function render(
  run: RunCapControlsRun,
  mocks: Record<string, () => Response | Promise<Response>> = {},
  openCap?: "max_loops" | "max_retries",
) {
  const { restore, calls } = installFetchMock(mocks);
  const result = renderWithClient(
    <MemoryRouter>
      <RunCapControls runId="run-1" run={run} _testInitialOpenCap={openCap ?? null} />
    </MemoryRouter>,
  );
  return { ...result, restore, calls };
}

function findInBody<T extends Element = HTMLElement>(testId: string): Promise<T> {
  return waitFor(() => {
    const el = document.body.querySelector(`[data-testid="${testId}"]`) as T | null;
    if (!el) throw new Error(`"${testId}" not found in document.body`);
    return el;
  });
}

describe("RunCapControls", () => {
  beforeEach(() => {
    successSpy.mockReset();
    errorSpy.mockReset();
  });
  afterEach(() => cleanup());

  test("raises max_loops on a running (unpaused) run", async () => {
    const { restore, calls } = render(RUNNING, { "/api/runs/run-1/max_loops": () => json({ seq: 3 }) }, "max_loops");
    try {
      const input = await findInBody<HTMLInputElement>("run-cap-input");
      fireEvent.change(input, { target: { value: "50" } });
      const confirm = await findInBody<HTMLButtonElement>("run-cap-confirm");
      fireEvent.click(confirm);

      const posted = await waitFor(() => {
        const c = calls.find((c) => c.url === "/api/runs/run-1/max_loops" && c.method === "POST");
        if (!c) throw new Error("POST /max_loops not called");
        return c;
      });
      expect(JSON.parse(posted.body as string)).toEqual({ newLimit: 50 });
    } finally {
      restore();
    }
  });

  test("max_retries dialog lists the run's nodes and posts nodeId + newLimit", async () => {
    const { restore, calls } = render(
      RUNNING,
      { "/api/runs/run-1/max_retries": () => json({ seq: 4 }) },
      "max_retries",
    );
    try {
      // The node picker is present; its options live in a Radix portal that
      // only mounts on open, so we assert the wiring via the POSTed nodeId —
      // the default is the first de-duped node identity ("review", which
      // appears twice in NODES but collapses to one).
      await findInBody("run-cap-node-select");

      const input = await findInBody<HTMLInputElement>("run-cap-input");
      fireEvent.change(input, { target: { value: "5" } });
      const confirm = await findInBody<HTMLButtonElement>("run-cap-confirm");
      fireEvent.click(confirm);

      const posted = await waitFor(() => {
        const c = calls.find((c) => c.url === "/api/runs/run-1/max_retries" && c.method === "POST");
        if (!c) throw new Error("POST /max_retries not called");
        return c;
      });
      expect(JSON.parse(posted.body as string)).toEqual({ nodeId: "review", newLimit: 5 });
    } finally {
      restore();
    }
  });

  test("renders nothing for terminal or imported runs", () => {
    const term = render(TERMINAL);
    try {
      expect(term.container.querySelector(`[data-testid="run-cap-trigger-run-1"]`)).toBeNull();
    } finally {
      term.restore();
    }
    const imp = render(IMPORTED);
    try {
      expect(imp.container.querySelector(`[data-testid="run-cap-trigger-run-1"]`)).toBeNull();
    } finally {
      imp.restore();
    }
  });
});
