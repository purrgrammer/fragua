// SteerInput component tests.
//
// We mock the `steerRun` API call at the `globalThis.fetch` boundary —
// SteerInput imports `steerRun` from `lib/api.ts`, which POSTs to
// `/api/runs/:id/steer` and expects `{ id }` back (202).

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
// Simulate is the only way to get React 18's synthetic onChange to fire
// on a controlled textarea under happy-dom.
import { Simulate } from "react-dom/test-utils";
import SteerInput from "../../src/components/SteerInput.tsx";
import type { ReconcileEvent } from "../../src/lib/usePendingSteers.ts";
import { installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

const STEER_URL = "/api/runs/run-1/steer";

function controlRequested(id: string): ReconcileEvent {
  return { type: "control.requested", data: { id, command: "steer", payload: { message: "x" } } };
}

describe("SteerInput", () => {
  useDom();
  afterEach(() => cleanup());

  it("submits a message, calls steerRun once, and renders a pending row", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const { restore } = installFetchMock({
      [STEER_URL]: ({ url, method }) => {
        calls.push({ url, method });
        return json({ id: "req-1" }, { status: 202 });
      },
    });

    try {
      const { getByTestId, queryByTestId } = renderWithClient(<SteerInput runId="run-1" events={[]} />);

      const textarea = getByTestId("steer-textarea") as HTMLTextAreaElement;
      textarea.value = "please refocus";
      Simulate.change(textarea);

      const form = getByTestId("steer-form") as HTMLFormElement;
      Simulate.submit(form);

      // A pending row with the message text appears immediately (local id).
      await waitFor(() => {
        expect(getByTestId("steer-pending-list")).toBeTruthy();
      });
      expect(getByTestId("steer-pending-list").textContent).toContain("please refocus");
      expect(getByTestId("steer-pending-list").textContent?.toLowerCase()).toContain("pending");

      // Wait for the mutation to resolve and the post-success row to render.
      await waitFor(() => {
        // After success the local-id row is replaced with a server-id row.
        expect(queryByTestId("steer-pending-req-1")).toBeTruthy();
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("POST");
    } finally {
      restore();
    }
  });

  it("clears the pending row when a matching control.requested arrives", async () => {
    const { restore } = installFetchMock({
      [STEER_URL]: () => json({ id: "req-1" }, { status: 202 }),
    });

    try {
      const { getByTestId, queryByTestId, rerender } = renderWithClient(<SteerInput runId="run-1" events={[]} />);

      const textarea = getByTestId("steer-textarea") as HTMLTextAreaElement;
      textarea.value = "go left";
      Simulate.change(textarea);
      Simulate.submit(getByTestId("steer-form"));

      await waitFor(() => {
        expect(queryByTestId("steer-pending-req-1")).toBeTruthy();
      });

      rerender(<SteerInput runId="run-1" events={[controlRequested("req-1")]} />);

      await waitFor(() => {
        expect(queryByTestId("steer-pending-req-1")).toBeNull();
        expect(queryByTestId("steer-pending-list")).toBeNull();
      });
    } finally {
      restore();
    }
  });

  it("shows a failed row with retry when steerRun rejects", async () => {
    let callCount = 0;
    const { restore } = installFetchMock({
      [STEER_URL]: () => {
        callCount += 1;
        if (callCount === 1) return new Response("boom", { status: 500 });
        return json({ id: "req-retry" }, { status: 202 });
      },
    });

    try {
      const { getByTestId, queryByTestId } = renderWithClient(<SteerInput runId="run-1" events={[]} />);

      const textarea = getByTestId("steer-textarea") as HTMLTextAreaElement;
      textarea.value = "retry me";
      Simulate.change(textarea);
      Simulate.submit(getByTestId("steer-form"));

      // Wait for the failure to register. The failed entry is keyed on
      // the local id, which we don't know — find it via the list text.
      await waitFor(() => {
        const list = queryByTestId("steer-pending-list");
        expect(list).toBeTruthy();
        expect(list?.textContent?.toLowerCase()).toContain("failed");
      });

      // Click retry — find the retry button by text since the id is synthetic.
      const list = getByTestId("steer-pending-list");
      const retryBtn = list.querySelector('[data-testid$="-retry"]') as HTMLButtonElement | null;
      expect(retryBtn).toBeTruthy();
      if (!retryBtn) return;

      fireEvent.click(retryBtn);

      await waitFor(() => {
        expect(callCount).toBe(2);
      });
      // After the retry resolves we should see the new server id row.
      await waitFor(() => {
        expect(queryByTestId("steer-pending-req-retry")).toBeTruthy();
      });
    } finally {
      restore();
    }
  });

  it("ignores empty or whitespace-only submissions", () => {
    const calls: Array<{ url: string }> = [];
    const { restore } = installFetchMock({
      [STEER_URL]: ({ url }) => {
        calls.push({ url });
        return json({ id: "req-x" }, { status: 202 });
      },
    });

    try {
      const { getByTestId, queryByTestId } = renderWithClient(<SteerInput runId="run-1" events={[]} />);

      const textarea = getByTestId("steer-textarea") as HTMLTextAreaElement;

      // Empty.
      Simulate.submit(getByTestId("steer-form"));
      expect(queryByTestId("steer-pending-list")).toBeNull();

      // Whitespace only.
      textarea.value = "   \n\t  ";
      Simulate.change(textarea);
      Simulate.submit(getByTestId("steer-form"));
      expect(queryByTestId("steer-pending-list")).toBeNull();

      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });
});
