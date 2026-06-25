// The reducer must fold the FULL contract-version range, not just v4. Events are
// an immutable, append-only log: a run pinned at v1–v3 carries the LEGACY
// terminal/pause facts (fact.run_completed / fact.run_halted / fact.run_cancelled
// / fact.run_paused_human), and the v4 reducer must still fold them to the same
// run_state.status the new facts (fact.run_terminated / fact.run_paused) produce.
// Emission stays v4-only; reading reaches back to MIN_COMPATIBLE.

import { describe, expect, test } from "bun:test";
import { applyFact, emptyMetrics, type FactEvent, type RunState } from "../src/index.ts";

function runningState(): RunState {
  return {
    runId: "r",
    version: 0,
    status: "running",
    currentNode: "work",
    workflowSha: "wf",
    contractVersion: 3,
    routing: {},
    metrics: emptyMetrics(),
    nextSeq: 1,
    lastAppliedSeq: 0,
    priority: 0,
    enqueuedAt: 0,
    readyAt: 0,
    nodeStartedAt: 100,
    dispatchStartedAt: 100,
    updatedAt: 0,
    title: null,
    baseGitSha: null,
    baseGitRef: null,
    finalGitSha: null,
    finalHeadRef: null,
    diffBaseSha: null,
    changeStat: null,
    inboxStatus: null,
    acceptedSha: null,
    cwd: null,
    projectId: "p",
    projectName: "p",
    workflowName: null,
    workflowScope: null,
    workflowPath: null,
    scheduleId: null,
  };
}

describe("legacy (≤v3) terminal/pause facts fold to the same run_state the v4 facts do", () => {
  test("fact.run_completed → status='completed' and currentNode=finalNode", () => {
    const fact = { type: "fact.run_completed", payload: { finalNode: "exit" } } as unknown as FactEvent;
    const next = applyFact(runningState(), fact, 200);
    expect(next.status).toBe("completed");
    expect(next.currentNode).toBe("exit");
    expect(next.nodeStartedAt).toBeNull();
  });

  test("fact.run_cancelled → status='cancelled'", () => {
    const fact = { type: "fact.run_cancelled", payload: { intentSeq: 7 } } as unknown as FactEvent;
    const next = applyFact(runningState(), fact, 200);
    expect(next.status).toBe("cancelled");
    expect(next.nodeStartedAt).toBeNull();
  });

  test("fact.run_halted → status='halted' and folds partial turn spend", () => {
    const fact = {
      type: "fact.run_halted",
      payload: {
        reason: "route_not_picked",
        detail: "boom",
        nodeId: "work",
        partialTokens: 30,
        partialCostUsd: 0.5,
        partialInputTokens: 20,
        partialOutputTokens: 10,
        partialInputCostUsd: 0.3,
        partialOutputCostUsd: 0.2,
      },
    } as unknown as FactEvent;
    const next = applyFact(runningState(), fact, 200);
    expect(next.status).toBe("halted");
    expect(next.metrics.billedTokens).toBe(30);
    expect(next.metrics.totalCostUsd).toBeCloseTo(0.5, 10);
    expect(next.metrics.nodeCosts["work"]).toEqual({ tokens: 30, costUsd: 0.5 });
  });

  test("fact.run_paused_human → status='paused_human'", () => {
    const fact = {
      type: "fact.run_paused_human",
      payload: { nodeId: "ask", text: "Approve?", routes: ["yes", "no"] },
    } as unknown as FactEvent;
    const next = applyFact(runningState(), fact, 200);
    expect(next.status).toBe("paused_human");
    expect(next.nodeStartedAt).toBeNull();
  });
});

// The strongest parity guard: each legacy fact must fold to a run_state that is
// DEEP-EQUAL to the run_state its v4 counterpart produces — not just matching on
// the few fields spot-checked above. A future edit that touches one arm but not
// the other (e.g. adds a field-set to fact.run_terminated{errored} only) fails
// here, where the spot-checks would silently pass.
describe("legacy fold is deep-equal to the v4 fold", () => {
  const cases: Array<{ name: string; legacy: FactEvent; v4: FactEvent }> = [
    {
      name: "completed ≡ run_terminated{completed}",
      legacy: { type: "fact.run_completed", payload: { finalNode: "exit" } } as unknown as FactEvent,
      v4: { type: "fact.run_terminated", payload: { status: "completed", finalNode: "exit" } } as unknown as FactEvent,
    },
    {
      name: "cancelled ≡ run_terminated{aborted}",
      legacy: { type: "fact.run_cancelled", payload: { intentSeq: 7 } } as unknown as FactEvent,
      v4: { type: "fact.run_terminated", payload: { status: "aborted", intentSeq: 7 } } as unknown as FactEvent,
    },
    {
      name: "halted ≡ run_terminated{errored} (with partial-turn spend)",
      legacy: {
        type: "fact.run_halted",
        payload: {
          reason: "route_not_picked",
          detail: "boom",
          nodeId: "work",
          partialTokens: 30,
          partialCostUsd: 0.5,
          partialInputTokens: 20,
          partialOutputTokens: 10,
          partialInputCostUsd: 0.3,
          partialOutputCostUsd: 0.2,
        },
      } as unknown as FactEvent,
      v4: {
        type: "fact.run_terminated",
        payload: {
          status: "errored",
          reason: "route_not_picked",
          detail: "boom",
          nodeId: "work",
          partialTokens: 30,
          partialCostUsd: 0.5,
          partialInputTokens: 20,
          partialOutputTokens: 10,
          partialInputCostUsd: 0.3,
          partialOutputCostUsd: 0.2,
        },
      } as unknown as FactEvent,
    },
    {
      name: "paused_human ≡ run_paused{reason:human}",
      legacy: {
        type: "fact.run_paused_human",
        payload: { nodeId: "ask", text: "Approve?", routes: ["yes", "no"] },
      } as unknown as FactEvent,
      v4: {
        type: "fact.run_paused",
        payload: { reason: "human", nodeId: "ask", text: "Approve?", routes: ["yes", "no"] },
      } as unknown as FactEvent,
    },
  ];

  for (const { name, legacy, v4 } of cases) {
    test(name, () => {
      expect(applyFact(runningState(), legacy, 200)).toEqual(applyFact(runningState(), v4, 200));
    });
  }
});
