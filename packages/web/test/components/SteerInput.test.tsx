// SteerInput component tests.
//
// We mock the `steerRun` API call at the `globalThis.fetch` boundary —
// SteerInput imports `steerRun` from `lib/api.ts`, which POSTs to
// `/api/runs/:id/steer` and expects `{ seq }` back.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
// Simulate is the only way to get React 18's synthetic onChange to fire
// on a controlled textarea under happy-dom.
import { Simulate } from "react-dom/test-utils";
import SteerInput from "../../src/components/SteerInput.tsx";
import type { RunMessageRow } from "../../src/lib/api.ts";
import { installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

const STEER_URL = "/api/runs/run-1/steer";

function userMsg(ordinal: number, text: string): RunMessageRow {
  return {
    ordinal,
    nodeId: null,
    iteration: 0,
    content: { role: "user", content: text, timestamp: 0 },
  };
}

describe("SteerInput", () => {
  useDom();
  afterEach(() => cleanup());

  it("submits a message, calls steerRun once, and renders a pending row", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const { restore } = installFetchMock({
      [STEER_URL]: ({ url, method }) => {
        calls.push({ url, method });
        return json({ seq: 7 });
      },
    });

    try {
      const { getByTestId } = renderWithClient(<SteerInput runId="run-1" messages={[]} />);

      const textarea = getByTestId("steer-textarea") as HTMLTextAreaElement;
      textarea.value = "please refocus";
      Simulate.change(textarea);

      const form = getByTestId("steer-form") as HTMLFormElement;
      Simulate.submit(form);

      await waitFor(() => {
        expect(getByTestId("steer-pending-list")).toBeTruthy();
      });
      expect(getByTestId("steer-pending-list").textContent).toContain("please refocus");
      expect(getByTestId("steer-pending-list").textContent?.toLowerCase()).toContain("pending");

      await waitFor(() => {
        expect(calls).toHaveLength(1);
      });
      expect(calls[0]?.method).toBe("POST");
    } finally {
      restore();
    }
  });

  it("clears the pending row when a matching user message appears in the conversation", async () => {
    const { restore } = installFetchMock({
      [STEER_URL]: () => json({ seq: 7 }),
    });

    try {
      const { getByTestId, queryByTestId, rerender } = renderWithClient(<SteerInput runId="run-1" messages={[]} />);

      const textarea = getByTestId("steer-textarea") as HTMLTextAreaElement;
      textarea.value = "go left";
      Simulate.change(textarea);
      Simulate.submit(getByTestId("steer-form"));

      await waitFor(() => {
        expect(queryByTestId("steer-pending-list")).toBeTruthy();
      });

      rerender(<SteerInput runId="run-1" messages={[userMsg(1, "go left")]} />);

      await waitFor(() => {
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
        return json({ seq: 9 });
      },
    });

    try {
      const { getByTestId, queryByTestId } = renderWithClient(<SteerInput runId="run-1" messages={[]} />);

      const textarea = getByTestId("steer-textarea") as HTMLTextAreaElement;
      textarea.value = "retry me";
      Simulate.change(textarea);
      Simulate.submit(getByTestId("steer-form"));

      await waitFor(() => {
        const list = queryByTestId("steer-pending-list");
        expect(list).toBeTruthy();
        expect(list?.textContent?.toLowerCase()).toContain("failed");
      });

      const list = getByTestId("steer-pending-list");
      const retryBtn = list.querySelector('[data-testid$="-retry"]') as HTMLButtonElement | null;
      expect(retryBtn).toBeTruthy();
      if (!retryBtn) return;

      fireEvent.click(retryBtn);

      await waitFor(() => {
        expect(callCount).toBe(2);
      });
      // The retry succeeds — the queue still has a pending row keyed on
      // a fresh local id; it'll drain when the user message arrives.
      await waitFor(() => {
        const text = queryByTestId("steer-pending-list")?.textContent?.toLowerCase() ?? "";
        expect(text).toContain("pending");
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
        return json({ seq: 1 });
      },
    });

    try {
      const { getByTestId, queryByTestId } = renderWithClient(<SteerInput runId="run-1" messages={[]} />);

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
