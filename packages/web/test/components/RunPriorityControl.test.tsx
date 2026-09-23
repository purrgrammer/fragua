// RunPriorityControl — behaviour tests.
//
// Covers: the queued-only render guard, and that submitting POSTs
// adjustPriority with the entered value.

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RunPriorityControl } from "../../src/components/RunPriorityControl.tsx";
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

const PRIORITY_URL = "/api/runs/run-1/priority";

function render(
  status: "queued" | "running",
  priority: number,
  mocks: Record<string, () => Response | Promise<Response>> = {},
) {
  const { restore, calls } = installFetchMock(mocks);
  const result = renderWithClient(
    <MemoryRouter>
      <RunPriorityControl runId="run-1" status={status} priority={priority} />
    </MemoryRouter>,
  );
  return { ...result, restore, calls };
}

describe("RunPriorityControl", () => {
  beforeEach(() => {
    successSpy.mockReset();
    errorSpy.mockReset();
  });
  afterEach(() => cleanup());

  test("renders only when status is queued", () => {
    const running = render("running", 0);
    try {
      expect(running.container.querySelector(`[data-testid="run-priority-control"]`)).toBeNull();
    } finally {
      running.restore();
    }

    const queued = render("queued", 3);
    try {
      const input = queued.container.querySelector<HTMLInputElement>(`[data-testid="run-priority-input"]`);
      expect(input).not.toBeNull();
      expect(input?.value).toBe("3");
    } finally {
      queued.restore();
    }
  });

  test("submitting posts adjustPriority with the entered value", async () => {
    const bodies: string[] = [];
    const { container, restore, calls } = render("queued", 0, {
      [PRIORITY_URL]: () => json({ seq: 9 }),
    });
    try {
      const input = container.querySelector<HTMLInputElement>(`[data-testid="run-priority-input"]`)!;
      fireEvent.change(input, { target: { value: "10" } });
      const setBtn = container.querySelector<HTMLButtonElement>(`[data-testid="run-priority-set"]`)!;
      fireEvent.click(setBtn);

      const posted = await waitFor(() => {
        const c = calls.find((c) => c.url === PRIORITY_URL && c.method === "POST");
        if (!c) throw new Error("POST /priority not called");
        return c;
      });
      bodies.push(posted.body as string);
      expect(JSON.parse(bodies[0] ?? "")).toEqual({ newPriority: 10 });
    } finally {
      restore();
    }
  });
});
