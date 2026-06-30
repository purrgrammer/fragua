// RunQuarantinedNotice — renders a destructive Alert when the run's events
// carry a `fact.run_quarantined`, surfacing the reason, the orphaned intent
// seqs, and the three `intent.unquarantine` resolutions as operator actions.

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunQuarantinedNotice } from "../../src/components/RunQuarantinedNotice.tsx";
import { installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";

const EVENTS_URL = "/api/runs/run-1/events.json";
const UNQUARANTINE_URL = "/api/runs/run-1/unquarantine";

const ORPHAN_EVENTS = [
  { seq: 1, type: "fact.run_started", payload: {} },
  { seq: 2, type: "fact.side_effect_intent", payload: { idempotencyKey: "k1" } },
  {
    seq: 3,
    type: "fact.run_quarantined",
    payload: { reason: "orphan_side_effect", orphanedIntents: [2, 7] },
  },
];

describe("RunQuarantinedNotice", () => {
  afterEach(() => cleanup());

  it("renders the reason, orphaned intent seqs, and all three resolution actions", async () => {
    const { restore } = installFetchMock({ [EVENTS_URL]: () => json(ORPHAN_EVENTS) });
    try {
      const { findByTestId } = renderWithClient(<RunQuarantinedNotice runId="run-1" />);
      const notice = await findByTestId("run-quarantined-notice");
      expect(notice.className).toContain("destructive");
      expect(notice.getAttribute("data-quarantine-reason")).toBe("orphan_side_effect");

      const orphans = await findByTestId("run-quarantined-orphans");
      expect(orphans.textContent).toContain("2, 7");

      // Exactly the three resolutions the `runs unquarantine` verb supports.
      expect(await findByTestId("run-quarantined-treat_as_done")).toBeDefined();
      expect(await findByTestId("run-quarantined-retry")).toBeDefined();
      expect(await findByTestId("run-quarantined-cancel")).toBeDefined();
    } finally {
      restore();
    }
  });

  it("a resolution button POSTs intent.unquarantine with that resolution", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const { restore } = installFetchMock({
      [EVENTS_URL]: () => json(ORPHAN_EVENTS),
      [UNQUARANTINE_URL]: ({ url, method, init }) => {
        calls.push({ url, method, body: init?.body });
        return json({ seq: 4 }, { status: 202 });
      },
    });
    try {
      const { findByTestId } = renderWithClient(<RunQuarantinedNotice runId="run-1" />);
      fireEvent.click(await findByTestId("run-quarantined-treat_as_done"));
      await waitFor(() => {
        const call = calls.find((c) => c.url === UNQUARANTINE_URL && c.method === "POST");
        expect(call).toBeDefined();
        expect(JSON.parse(String(call?.body))).toEqual({ resolution: "treat_as_done" });
      });
    } finally {
      restore();
    }
  });

  it("hides the action buttons for an imported run (informational only)", async () => {
    const { restore } = installFetchMock({ [EVENTS_URL]: () => json(ORPHAN_EVENTS) });
    try {
      const { findByTestId, queryByTestId } = renderWithClient(<RunQuarantinedNotice runId="run-1" imported />);
      expect(await findByTestId("run-quarantined-notice")).toBeDefined();
      expect(queryByTestId("run-quarantined-treat_as_done")).toBeNull();
    } finally {
      restore();
    }
  });

  it("hides itself once a later run-state fact (resume / terminate) supersedes the quarantine", async () => {
    const { restore } = installFetchMock({
      [EVENTS_URL]: () =>
        json([
          ...ORPHAN_EVENTS,
          { seq: 4, type: "fact.run_resumed", payload: { fromStatus: "quarantined" } },
          { seq: 5, type: "fact.run_terminated", payload: { status: "completed" } },
        ]),
    });
    try {
      const { queryByTestId } = renderWithClient(<RunQuarantinedNotice runId="run-1" />);
      await waitFor(() => {
        expect(queryByTestId("run-quarantined-notice")).toBeNull();
      });
    } finally {
      restore();
    }
  });

  it("renders without an orphans row when none are recorded (reason: other)", async () => {
    const { restore } = installFetchMock({
      [EVENTS_URL]: () => json([{ seq: 1, type: "fact.run_quarantined", payload: { reason: "other" } }]),
    });
    try {
      const { findByTestId, queryByTestId } = renderWithClient(<RunQuarantinedNotice runId="run-1" />);
      const notice = await findByTestId("run-quarantined-notice");
      expect(notice.getAttribute("data-quarantine-reason")).toBe("other");
      expect(queryByTestId("run-quarantined-orphans")).toBeNull();
    } finally {
      restore();
    }
  });
});
