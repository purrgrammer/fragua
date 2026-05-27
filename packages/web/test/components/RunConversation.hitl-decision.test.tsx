// RunConversation — HITL decision banner rendering.
//
// After a human gate closes, RunConversation surfaces the operator's
// recorded answer (route + optional note) as a "Responded" banner in the
// owning node section. The decisions come from `hitlDecisions` (a per-node
// map derived from the event log), so they render on reload and for any
// observer — not just the operator who clicked.

import { cleanup, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunConversation } from "../../src/components/RunConversation.tsx";
import type { NodeState, RunMessageRow } from "../../src/lib/api.ts";
import { renderWithClient } from "../helpers/with-query-client.tsx";

function userRow(ordinal: number, nodeId: string, text: string): RunMessageRow {
  return {
    ordinal,
    nodeId,
    iteration: 0,
    content: { role: "user", content: text, timestamp: 0 },
  };
}

describe("RunConversation — HITL decision banner", () => {
  afterEach(() => cleanup());

  it("renders the decision banner inside the matching node section", () => {
    const messages: RunMessageRow[] = [userRow(1, "review", "Please review the diff.")];
    const nodeStates: NodeState[] = [{ nodeId: "review", iteration: 0, state: "completed", lastEventSeq: 2 }];

    const { container } = renderWithClient(
      <RunConversation
        messages={messages}
        nodeStates={nodeStates}
        hitl={null}
        hitlDecisions={{ review: { route: "approve" } }}
      />,
    );

    const section = within(container).getByTestId("node-section-review");
    const banner = within(section).getByTestId("hitl-decision-banner");
    expect(within(banner).getByTestId("hitl-decision-route").textContent).toBe("Approve");
  });

  it("renders the note when present and humanizes the route name", () => {
    const { container } = renderWithClient(
      <RunConversation
        messages={[]}
        hitl={null}
        hitlDecisions={{ gate: { route: "needs_more_info", note: "Looks good to me" } }}
      />,
    );

    const banner = within(container).getByTestId("hitl-decision-banner");
    expect(within(banner).getByTestId("hitl-decision-route").textContent).toBe("Needs More Info");
    expect(within(banner).getByTestId("hitl-decision-note").textContent).toBe("Looks good to me");
  });

  it("omits the note element when the decision has no note", () => {
    const { container } = renderWithClient(
      <RunConversation messages={[]} hitl={null} hitlDecisions={{ gate: { route: "continue" } }} />,
    );

    const banner = within(container).getByTestId("hitl-decision-banner");
    expect(within(banner).queryByTestId("hitl-decision-note")).toBeNull();
  });

  it("synthesises an orphan section when the decided node produced no messages", () => {
    const nodeStates: NodeState[] = [{ nodeId: "approve_step", iteration: 0, state: "completed", lastEventSeq: 3 }];

    const { container } = renderWithClient(
      <RunConversation
        messages={[]}
        nodeStates={nodeStates}
        hitl={null}
        hitlDecisions={{ approve_step: { route: "approved" } }}
      />,
    );

    const section = within(container).getByTestId("node-section-approve_step");
    expect(within(section).getByTestId("hitl-decision-banner")).toBeTruthy();
  });

  it("does not render any banner when hitlDecisions is null", () => {
    const { container } = renderWithClient(
      <RunConversation messages={[userRow(1, "review", "Check this.")]} hitl={null} hitlDecisions={null} />,
    );

    expect(container.querySelector('[data-testid="hitl-decision-banner"]')).toBeNull();
  });

  it("suppresses the banner for the currently-open gate (card takes precedence)", () => {
    // Loop re-entry: a stale decision exists for `review`, but the gate is
    // open again at the same node. The card shows; the banner does not.
    const messages: RunMessageRow[] = [userRow(1, "review", "Check again?")];

    const { container } = renderWithClient(
      <RunConversation
        messages={messages}
        isPaused
        hitl={{ runId: "run-1", nodeId: "review", label: "Approve?", options: ["approve", "reject"] }}
        hitlDecisions={{ review: { route: "reject" } }}
      />,
    );

    const section = within(container).getByTestId("node-section-review");
    expect(within(section).getByTestId("hitl-step-card")).toBeTruthy();
    expect(within(section).queryByTestId("hitl-decision-banner")).toBeNull();
  });

  it("places each decision banner in its own node section", () => {
    const messages: RunMessageRow[] = [userRow(1, "fetch", "Fetching."), userRow(2, "review", "Here is the data.")];
    const nodeStates: NodeState[] = [
      { nodeId: "fetch", iteration: 0, state: "completed", lastEventSeq: 1 },
      { nodeId: "review", iteration: 0, state: "completed", lastEventSeq: 3 },
    ];

    const { container } = renderWithClient(
      <RunConversation
        messages={messages}
        nodeStates={nodeStates}
        hitl={null}
        hitlDecisions={{ review: { route: "approve" } }}
      />,
    );

    const fetchSection = within(container).getByTestId("node-section-fetch");
    const reviewSection = within(container).getByTestId("node-section-review");
    expect(within(reviewSection).getByTestId("hitl-decision-banner")).toBeTruthy();
    expect(within(fetchSection).queryByTestId("hitl-decision-banner")).toBeNull();
  });

  it("places a message-less gate's banner in node-execution order, not at the tail", () => {
    // Reproduces run 01ks7zv4…: verify → signoff (human, no messages) →
    // apply. The signoff banner must land between verify and apply, not
    // after apply (the tail), which is where the old orphan block dumped it.
    const messages: RunMessageRow[] = [userRow(1, "verify", "Checks pass."), userRow(2, "apply", "Applying…")];
    const nodeStates: NodeState[] = [
      { nodeId: "verify", iteration: 0, state: "completed", lastEventSeq: 10 },
      { nodeId: "signoff", iteration: 0, state: "completed", lastEventSeq: 20 },
      { nodeId: "apply", iteration: 0, state: "completed", lastEventSeq: 30 },
    ];

    const { container } = renderWithClient(
      <RunConversation
        messages={messages}
        nodeStates={nodeStates}
        hitl={null}
        hitlDecisions={{ signoff: { route: "apply" } }}
      />,
    );

    const order = Array.from(container.querySelectorAll('[data-testid^="node-section-"]')).map((el) =>
      el.getAttribute("data-testid"),
    );
    const iVerify = order.indexOf("node-section-verify");
    const iSignoff = order.indexOf("node-section-signoff");
    const iApply = order.indexOf("node-section-apply");
    expect(iVerify).toBeGreaterThanOrEqual(0);
    expect(iSignoff).toBeGreaterThan(iVerify);
    expect(iSignoff).toBeLessThan(iApply);
    // And the banner lives in that signoff section.
    const signoffSection = within(container).getByTestId("node-section-signoff");
    expect(within(signoffSection).getByTestId("hitl-decision-banner")).toBeTruthy();
  });

  it("places a message-less gate's banner in execution order when nodeStates arrive alphabetically (server sort)", () => {
    // The server's deriveNodeStates sorts detail.nodes alphabetically by nodeId.
    // Execution order was verify(seq=10) → signoff(seq=20) → apply(seq=30),
    // but nodeStates arrives as apply < signoff < verify (alphabetical).
    // decisionBuckets builds its `order` map from the array index position,
    // so it sees apply=0, signoff=1, verify=2 — which is the opposite of
    // execution order. This causes signoff's banner to be slotted after
    // apply (last section), not between verify and apply.
    const messages: RunMessageRow[] = [userRow(1, "verify", "Checks pass."), userRow(2, "apply", "Applying…")];
    // Alphabetical order, exactly as deriveNodeStates returns it.
    const nodeStates: NodeState[] = [
      { nodeId: "apply", iteration: 0, state: "completed", lastEventSeq: 30 },
      { nodeId: "signoff", iteration: 0, state: "completed", lastEventSeq: 20 },
      { nodeId: "verify", iteration: 0, state: "completed", lastEventSeq: 10 },
    ];

    const { container } = renderWithClient(
      <RunConversation
        messages={messages}
        nodeStates={nodeStates}
        hitl={null}
        hitlDecisions={{ signoff: { route: "apply" } }}
      />,
    );

    const order = Array.from(container.querySelectorAll('[data-testid^="node-section-"]')).map((el) =>
      el.getAttribute("data-testid"),
    );
    const iVerify = order.indexOf("node-section-verify");
    const iSignoff = order.indexOf("node-section-signoff");
    const iApply = order.indexOf("node-section-apply");
    expect(iVerify).toBeGreaterThanOrEqual(0);
    // signoff ran between verify and apply — its banner must appear there.
    expect(iSignoff).toBeGreaterThan(iVerify);
    expect(iSignoff).toBeLessThan(iApply);
    const signoffSection = within(container).getByTestId("node-section-signoff");
    expect(within(signoffSection).getByTestId("hitl-decision-banner")).toBeTruthy();
  });
});
