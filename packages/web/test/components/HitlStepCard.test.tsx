import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HitlStepCard } from "../../src/components/run-conversation/HitlStepCard.tsx";
import { installFetchMock, renderWithClient } from "../helpers/with-query-client.tsx";

describe("HitlStepCard — after an accepted submit", () => {
  afterEach(() => cleanup());

  it("replaces the buttons with the decision banner as soon as the POST is accepted", async () => {
    const HUMAN_URL = "/api/runs/run-7/human";
    const { calls, restore } = installFetchMock({
      [HUMAN_URL]: () =>
        new Response(JSON.stringify({ seq: 3 }), { status: 202, headers: { "content-type": "application/json" } }),
    });
    try {
      const { container } = renderWithClient(
        <HitlStepCard runId="run-7" label="Continue or redo?" options={["continue", "redo"]} />,
      );
      fireEvent.click(within(container).getByRole("button", { name: "Continue" }));
      await waitFor(() => {
        expect(container.querySelector('[data-testid="hitl-decision-banner"]')).not.toBeNull();
      });
      expect(container.querySelector('[data-testid="hitl-step-card"]')).toBeNull();
      expect(within(container).queryByRole("button", { name: "Continue" })).toBeNull();
      expect(calls.filter((c) => c.url === HUMAN_URL && c.method === "POST")).toHaveLength(1);
      expect(container.textContent).toContain("Continue");
    } finally {
      restore();
    }
  });
});
