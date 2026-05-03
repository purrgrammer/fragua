// RunPausedNotice — renders a destructive Alert when the run's events
// carry a `fact.run_paused` and dispatches body / actions on the
// payload's `reason`.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { RunPausedNotice } from "../../src/components/RunPausedNotice.tsx";
import { installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

const EVENTS_URL = "/api/runs/run-1/events.json";
const RESUME_URL = "/api/runs/run-1/resume";
const CANCEL_URL = "/api/runs/run-1/cancel";
const BUDGET_URL = "/api/runs/run-1/budget";

const PROVIDER_ERROR_EVENTS = [
  { seq: 1, type: "fact.run_started", payload: {} },
  { seq: 2, type: "fact.node_started", payload: { nodeId: "implement", iteration: 0 } },
  {
    seq: 3,
    type: "fact.run_paused",
    payload: {
      reason: "provider_error",
      nodeId: "implement",
      httpStatus: 500,
      provider: "anthropic",
      errorMessage: "Internal Server Error",
    },
  },
];

describe("RunPausedNotice", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders the alert with provider label (verbatim), HTTP code, and reason", async () => {
    const { restore } = installFetchMock({
      [EVENTS_URL]: () => json(PROVIDER_ERROR_EVENTS),
    });
    try {
      const { findByTestId } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const message = await findByTestId("run-paused-message");
      expect(message.textContent).toBe("anthropic returned 500 (Internal Server Error)");
    } finally {
      restore();
    }
  });

  it("custom provider names render verbatim and the status code is pulled from errorMessage on httpStatus=null", async () => {
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          {
            seq: 1,
            type: "fact.run_paused",
            payload: {
              reason: "provider_error",
              nodeId: "implement",
              httpStatus: null,
              provider: "ppq",
              errorMessage: '503 "Service Unavailable"',
            },
          },
        ]),
    });
    try {
      const { findByTestId } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const message = await findByTestId("run-paused-message");
      expect(message.textContent).toBe("ppq returned 503 (Service Unavailable)");
    } finally {
      restore();
    }
  });

  it("hides itself once a later run-state fact (resume / cancel) supersedes the pause", async () => {
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          ...PROVIDER_ERROR_EVENTS,
          { seq: 4, type: "fact.run_resumed", payload: { fromStatus: "paused" } },
          { seq: 5, type: "fact.run_cancelled", payload: { intentSeq: 4 } },
        ]),
    });
    try {
      const { queryByTestId } = renderWithClient(<RunPausedNotice runId="run-1" />);
      await waitFor(() => {
        expect(queryByTestId("run-paused-notice")).toBeNull();
      });
    } finally {
      restore();
    }
  });

  it("renders nothing when no fact.run_paused is present (e.g., paused_hitl-only)", async () => {
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          { seq: 1, type: "fact.run_started", payload: {} },
          { seq: 2, type: "fact.run_paused_hitl", payload: { nodeId: "n", prompt: "approve?" } },
        ]),
    });
    try {
      const { queryByTestId } = renderWithClient(<RunPausedNotice runId="run-1" />);
      await waitFor(() => {
        expect(queryByTestId("run-paused-notice")).toBeNull();
      });
    } finally {
      restore();
    }
  });

  it("falls back to a network-error label when neither httpStatus nor a status code in the message", async () => {
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          {
            seq: 1,
            type: "fact.run_paused",
            payload: {
              reason: "provider_error",
              nodeId: "n",
              httpStatus: null,
              provider: "openai",
              errorMessage: "ECONNRESET",
            },
          },
        ]),
    });
    try {
      const { findByTestId } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const message = await findByTestId("run-paused-message");
      expect(message.textContent).toBe("openai network error: ECONNRESET");
    } finally {
      restore();
    }
  });

  it("payment_required reason renders the top-up prompt", async () => {
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          {
            seq: 1,
            type: "fact.run_paused",
            payload: {
              reason: "payment_required",
              nodeId: "implement",
              provider: "anthropic",
              errorMessage: '402 "Payment Required"',
            },
          },
        ]),
    });
    try {
      const { findByTestId } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const message = await findByTestId("run-paused-message");
      expect(message.textContent).toContain("anthropic");
      expect(message.textContent).toContain("payment required");
    } finally {
      restore();
    }
  });

  it("operator reason renders the operator-pause body", async () => {
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          {
            seq: 1,
            type: "fact.run_paused",
            payload: { reason: "operator", nodeId: "implement" },
          },
        ]),
    });
    try {
      const { findByTestId } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const message = await findByTestId("run-paused-message");
      expect(message.textContent).toContain("operator");
    } finally {
      restore();
    }
  });

  it("budget reason exposes the Raise & Resume action", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          {
            seq: 1,
            type: "fact.run_paused",
            payload: {
              reason: "budget",
              nodeId: "implement",
              scope: "run",
              metric: "cost",
              limit: 1.0,
              actual: 1.5,
            },
          },
        ]),
      [BUDGET_URL]: ({ url, method, init }) => {
        calls.push({ url, method, body: init?.body });
        return json({ seq: 4 }, { status: 202 });
      },
      [RESUME_URL]: ({ url, method }) => {
        calls.push({ url, method, body: undefined });
        return json({ seq: 5 }, { status: 202 });
      },
    });
    try {
      const { findByTestId } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const input = (await findByTestId("run-paused-budget-input")) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "2.5" } });
      const raiseBtn = (await findByTestId("run-paused-raise-resume")) as HTMLButtonElement;
      await waitFor(() => {
        expect(raiseBtn.disabled).toBe(false);
      });
      fireEvent.click(raiseBtn);
      await waitFor(() => {
        expect(calls.some((c) => c.url === BUDGET_URL && c.method === "POST")).toBe(true);
        expect(calls.some((c) => c.url === RESUME_URL && c.method === "POST")).toBe(true);
      });
    } finally {
      restore();
    }
  });

  it("Resume button POSTs intent.resume", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const { restore } = installFetchMock({
      [EVENTS_URL]: () => json(PROVIDER_ERROR_EVENTS),
      [RESUME_URL]: ({ url, method }) => {
        calls.push({ url, method });
        return json({ id: "run-1" }, { status: 202 });
      },
    });
    try {
      const { findByTestId } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const resumeBtn = await findByTestId("run-paused-resume");
      fireEvent.click(resumeBtn);
      await waitFor(() => {
        expect(calls.some((c) => c.url === RESUME_URL && c.method === "POST")).toBe(true);
      });
    } finally {
      restore();
    }
  });

  it("Cancel button POSTs intent.cancel_requested", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const { restore } = installFetchMock({
      [EVENTS_URL]: () => json(PROVIDER_ERROR_EVENTS),
      [CANCEL_URL]: ({ url, method }) => {
        calls.push({ url, method });
        return json({ id: "run-1" }, { status: 202 });
      },
    });
    try {
      const { findByTestId } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const cancelBtn = await findByTestId("run-paused-cancel");
      fireEvent.click(cancelBtn);
      await waitFor(() => {
        expect(calls.some((c) => c.url === CANCEL_URL && c.method === "POST")).toBe(true);
      });
    } finally {
      restore();
    }
  });
});
