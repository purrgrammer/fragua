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

  it("renders nothing when no fact.run_paused is present (e.g., paused_human-only)", async () => {
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          { seq: 1, type: "fact.run_started", payload: {} },
          { seq: 2, type: "fact.run_paused_human", payload: { nodeId: "n", prompt: "approve?" } },
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

  it("renders budget amounts with exactly two decimals and seeds the input to 2dp", async () => {
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          {
            seq: 1,
            type: "fact.run_paused",
            payload: { reason: "budget", nodeId: "implement", scope: "run", metric: "cost", limit: 0.3, actual: 0.4567 },
          },
        ]),
    });
    try {
      const { findByTestId } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const message = await findByTestId("run-paused-message");
      // actual/limit rendered to 2dp with a leading $, no extra precision.
      expect(message.textContent).toContain("$0.46");
      expect(message.textContent).toContain("$0.30");
      expect(message.textContent).not.toContain("0.4567");
      const input = (await findByTestId("run-paused-budget-input")) as HTMLInputElement;
      expect(input.value).toBe("0.30");
    } finally {
      restore();
    }
  });

  it("does not style a budget pause as destructive (it is an expected gate, not an error)", async () => {
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          {
            seq: 1,
            type: "fact.run_paused",
            payload: { reason: "budget", nodeId: "implement", scope: "run", metric: "cost", limit: 1, actual: 2 },
          },
        ]),
    });
    try {
      const { findByTestId } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const notice = await findByTestId("run-paused-notice");
      expect(notice.className).not.toContain("destructive");
    } finally {
      restore();
    }
  });

  it("styles a provider_error pause as destructive", async () => {
    const { restore } = installFetchMock({
      [EVENTS_URL]: () => json(PROVIDER_ERROR_EVENTS),
    });
    try {
      const { findByTestId } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const notice = await findByTestId("run-paused-notice");
      expect(notice.className).toContain("destructive");
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

  it("provider_retry reason renders countdown body + Resume now / Cancel actions", async () => {
    const resumeAt = Date.now() + 30_000;
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          {
            seq: 1,
            type: "fact.run_paused",
            payload: {
              reason: "provider_retry",
              nodeId: "implement",
              httpStatus: 429,
              provider: "anthropic",
              errorMessage: "429 Too Many Requests",
              attempt: 2,
              resumeAt,
            },
          },
        ]),
    });
    try {
      const { findByTestId, getByText } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const message = await findByTestId("run-paused-message");
      // Body carries the formatted provider error + attempt count + countdown.
      expect(message.textContent).toContain("anthropic returned 429");
      expect(message.textContent).toContain("attempt 2");
      // Countdown reads "in 30s" (or similar — we ceil to the nearest second).
      expect(message.textContent).toMatch(/in \d+s/);
      // Resume button label is "Resume now" for auto-wake reasons.
      expect(getByText("Resume now")).toBeDefined();
      // The notice carries the reason discriminator for selector clarity.
      const notice = await findByTestId("run-paused-notice");
      expect(notice.getAttribute("data-pause-reason")).toBe("provider_retry");
    } finally {
      restore();
    }
  });

  it("handler_retry reason renders countdown + attempt-of-max + Resume now / Cancel actions", async () => {
    const resumeAt = Date.now() + 5_000;
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          {
            seq: 1,
            type: "fact.run_paused",
            payload: {
              reason: "handler_retry",
              nodeId: "verify",
              attempt: 2,
              delayMs: 5_000,
              resumeAt,
              maxRetries: 3,
            },
          },
        ]),
    });
    try {
      const { findByTestId, getByText } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const message = await findByTestId("run-paused-message");
      expect(message.textContent).toContain("verify");
      expect(message.textContent).toContain("attempt 2/3");
      expect(message.textContent).toMatch(/in \d+s/);
      expect(getByText("Resume now")).toBeDefined();
      const notice = await findByTestId("run-paused-notice");
      expect(notice.getAttribute("data-pause-reason")).toBe("handler_retry");
    } finally {
      restore();
    }
  });

  it("timeout_retry reason renders watchdog body with attempted-ms + countdown + Resume now", async () => {
    const resumeAt = Date.now() + 5_000;
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          {
            seq: 1,
            type: "fact.run_paused",
            payload: {
              reason: "timeout_retry",
              nodeId: "implement",
              attempt: 1,
              delayMs: 5_000,
              resumeAt,
              maxAttempts: 3,
              attemptedMs: 30 * 60_000,
            },
          },
        ]),
    });
    try {
      const { findByTestId, getByText } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const message = await findByTestId("run-paused-message");
      expect(message.textContent).toContain("implement");
      expect(message.textContent).toContain("attempt 1/3");
      expect(message.textContent).toContain("30m");
      expect(message.textContent).toMatch(/in \d+s/);
      // Watchdog reads "Transcript preserved" so operators know the
      // dispatch's prior work survives the resume.
      expect(message.textContent).toContain("Transcript preserved");
      expect(getByText("Resume now")).toBeDefined();
      const notice = await findByTestId("run-paused-notice");
      expect(notice.getAttribute("data-pause-reason")).toBe("timeout_retry");
    } finally {
      restore();
    }
  });

  it("max_retries reason exposes Raise & Resume + per-node cap input", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          {
            seq: 1,
            type: "fact.run_paused",
            payload: { reason: "max_retries", nodeId: "verify", currentLimit: 3, attempts: 3 },
          },
        ]),
      "/api/runs/run-1/max_retries": ({ url, method }) => {
        calls.push({ url, method });
        return json({ seq: 4 }, { status: 202 });
      },
      [RESUME_URL]: ({ url, method }) => {
        calls.push({ url, method });
        return json({ seq: 5 }, { status: 202 });
      },
    });
    try {
      const { findByTestId } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const message = await findByTestId("run-paused-message");
      expect(message.textContent).toContain("verify");
      expect(message.textContent).toContain("3 of 3 retries");
      const input = (await findByTestId("run-paused-cap-input")) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "5" } });
      const raiseBtn = (await findByTestId("run-paused-raise-resume")) as HTMLButtonElement;
      fireEvent.click(raiseBtn);
      await waitFor(() => {
        expect(calls.some((c) => c.url === "/api/runs/run-1/max_retries" && c.method === "POST")).toBe(true);
        expect(calls.some((c) => c.url === RESUME_URL && c.method === "POST")).toBe(true);
      });
    } finally {
      restore();
    }
  });

  it("goal_gate reason exposes Raise & Resume targeting max_goal_gate_retries", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          {
            seq: 1,
            type: "fact.run_paused",
            payload: { reason: "goal_gate", gateNodeId: "review", currentLimit: 2 },
          },
        ]),
      "/api/runs/run-1/goal_gate": ({ url, method }) => {
        calls.push({ url, method });
        return json({ seq: 4 }, { status: 202 });
      },
      [RESUME_URL]: ({ url, method }) => {
        calls.push({ url, method });
        return json({ seq: 5 }, { status: 202 });
      },
    });
    try {
      const { findByTestId } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const message = await findByTestId("run-paused-message");
      expect(message.textContent).toContain("review");
      expect(message.textContent).toContain("2 retarget cycles");
      const input = (await findByTestId("run-paused-cap-input")) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "5" } });
      const raiseBtn = (await findByTestId("run-paused-raise-resume")) as HTMLButtonElement;
      fireEvent.click(raiseBtn);
      await waitFor(() => {
        expect(calls.some((c) => c.url === "/api/runs/run-1/goal_gate" && c.method === "POST")).toBe(true);
      });
    } finally {
      restore();
    }
  });

  it("max_loops reason exposes Raise & Resume targeting the dispatch ceiling", async () => {
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          {
            seq: 1,
            type: "fact.run_paused",
            payload: { reason: "max_loops", currentLimit: 1000, dispatches: 1000 },
          },
        ]),
    });
    try {
      const { findByTestId } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const message = await findByTestId("run-paused-message");
      expect(message.textContent).toContain("1000 dispatches");
      expect(await findByTestId("run-paused-cap-input")).toBeDefined();
      expect(await findByTestId("run-paused-raise-resume")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("abort_loop reason renders Resume / Cancel only (no per-run cap knob)", async () => {
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          {
            seq: 1,
            type: "fact.run_paused",
            payload: { reason: "abort_loop", nodeId: "implement", consecutiveAborts: 5 },
          },
        ]),
    });
    try {
      const { findByTestId, queryByTestId } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const message = await findByTestId("run-paused-message");
      expect(message.textContent).toContain("implement");
      expect(message.textContent).toContain("5 consecutive");
      // No cap input — abort-loop ceiling is daemon config, not per-run.
      expect(queryByTestId("run-paused-cap-input")).toBeNull();
      expect(await findByTestId("run-paused-resume")).toBeDefined();
      expect(await findByTestId("run-paused-cancel")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("provider_exhausted reason renders Resume / Cancel only", async () => {
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          {
            seq: 1,
            type: "fact.run_paused",
            payload: { reason: "provider_exhausted", nodeId: "implement", attempts: 5, cumulativeMs: 300_000 },
          },
        ]),
    });
    try {
      const { findByTestId, queryByTestId } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const message = await findByTestId("run-paused-message");
      expect(message.textContent).toContain("5 attempts");
      // No cap input — chain config is daemon-wide, not per-run.
      expect(queryByTestId("run-paused-cap-input")).toBeNull();
      expect(await findByTestId("run-paused-resume")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("auto-wake countdown renders 'now' once resumeAt is in the past", async () => {
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          {
            seq: 1,
            type: "fact.run_paused",
            payload: {
              reason: "handler_retry",
              nodeId: "verify",
              attempt: 1,
              delayMs: 1,
              resumeAt: Date.now() - 1_000,
              maxRetries: 3,
            },
          },
        ]),
    });
    try {
      const { findByTestId } = renderWithClient(<RunPausedNotice runId="run-1" />);
      const message = await findByTestId("run-paused-message");
      expect(message.textContent).toContain("now");
    } finally {
      restore();
    }
  });
});
