// RunPausedNotice — imported=true renders strictly-informational banners
// (no action buttons).

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunPausedNotice } from "../../src/components/RunPausedNotice.tsx";
import { installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";

const EVENTS_URL = "/api/runs/run-1/events.json";

const BUDGET_EVENTS = [
  { seq: 1, type: "fact.run_started", payload: {} },
  { seq: 2, type: "fact.node_started", payload: { nodeId: "work", iteration: 0 } },
  {
    seq: 3,
    type: "fact.run_paused",
    payload: {
      reason: "budget",
      nodeId: "work",
      scope: "run",
      metric: "cost",
      limit: 1.0,
      actual: 1.05,
    },
  },
];

const PROVIDER_EXHAUSTED_EVENTS = [
  { seq: 1, type: "fact.run_started", payload: {} },
  {
    seq: 2,
    type: "fact.run_paused",
    payload: {
      reason: "provider_exhausted",
      nodeId: "work",
      attempts: 3,
      cumulativeMs: 5000,
    },
  },
];

describe("RunPausedNotice — imported runs are strictly informational", () => {
  afterEach(() => cleanup());

  it("renders the pause reason title + body for a budget pause when imported=true", async () => {
    const { restore } = installFetchMock({ [EVENTS_URL]: () => json(BUDGET_EVENTS) });
    try {
      const { findByTestId } = renderWithClient(<RunPausedNotice runId="run-1" imported />);
      const notice = await findByTestId("run-paused-notice");
      expect(notice).toBeTruthy();
      expect(notice.textContent).toMatch(/budget|limit|cost/i);
    } finally {
      restore();
    }
  });

  it("omits Resume / Cancel / Raise-budget buttons when imported=true (budget pause)", async () => {
    const { restore } = installFetchMock({ [EVENTS_URL]: () => json(BUDGET_EVENTS) });
    try {
      const { findByTestId, queryAllByRole } = renderWithClient(<RunPausedNotice runId="run-1" imported />);
      await findByTestId("run-paused-notice");
      const buttons = queryAllByRole("button");
      expect(buttons.length).toBe(0);
    } finally {
      restore();
    }
  });

  it("omits action buttons for provider_exhausted when imported=true", async () => {
    const { restore } = installFetchMock({ [EVENTS_URL]: () => json(PROVIDER_EXHAUSTED_EVENTS) });
    try {
      const { findByTestId, queryAllByRole } = renderWithClient(<RunPausedNotice runId="run-1" imported />);
      await findByTestId("run-paused-notice");
      const buttons = queryAllByRole("button");
      expect(buttons.length).toBe(0);
    } finally {
      restore();
    }
  });

  it("renders action buttons when imported=false (regression guard — normal run has actions)", async () => {
    const { restore } = installFetchMock({ [EVENTS_URL]: () => json(BUDGET_EVENTS) });
    try {
      const { findByTestId, queryAllByRole } = renderWithClient(<RunPausedNotice runId="run-1" imported={false} />);
      await findByTestId("run-paused-notice");
      const buttons = queryAllByRole("button");
      expect(buttons.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });
});
