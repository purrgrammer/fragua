// Reducer projection tests for the v4 fact-taxonomy collapse
// (fact-taxonomy.md §3.1–3.2): the THREE terminal facts collapse into one
// `fact.run_terminated { status }` and `fact.run_paused_human` folds into
// `fact.run_paused { reason: "human" }`. The FACT collapses; the
// `run_state.status` PROJECTION keeps its values — this pins the fold.

import { describe, expect, test } from "bun:test";
import { applyFact, emptyMetrics, type FactEvent, type RunState } from "../src/index.ts";

function runningState(): RunState {
  return {
    runId: "r",
    version: 0,
    status: "running",
    currentNode: "work",
    workflowSha: "wf",
    contractVersion: 4,
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

describe("v4 terminal collapse — fact.run_terminated projects run_state.status", () => {
  test("status:completed → status='completed' and currentNode=finalNode", () => {
    const fact: FactEvent = { type: "fact.run_terminated", payload: { status: "completed", finalNode: "exit" } };
    const next = applyFact(runningState(), fact, 200);
    expect(next.status).toBe("completed");
    expect(next.currentNode).toBe("exit");
    expect(next.nodeStartedAt).toBeNull();
  });

  test("status:aborted → status='cancelled'", () => {
    const fact: FactEvent = { type: "fact.run_terminated", payload: { status: "aborted", intentSeq: 7 } };
    const next = applyFact(runningState(), fact, 200);
    expect(next.status).toBe("cancelled");
    expect(next.nodeStartedAt).toBeNull();
  });

  test("status:errored → status='halted'", () => {
    const fact: FactEvent = {
      type: "fact.run_terminated",
      payload: { status: "errored", reason: "error", detail: "boom" },
    };
    const next = applyFact(runningState(), fact, 200);
    expect(next.status).toBe("halted");
    expect(next.nodeStartedAt).toBeNull();
  });

  test("status:errored folds partial turn spend into metrics (parity with the former run_halted fold)", () => {
    const fact: FactEvent = {
      type: "fact.run_terminated",
      payload: {
        status: "errored",
        reason: "route_not_picked",
        nodeId: "work",
        partialTokens: 30,
        partialCostUsd: 0.5,
        partialInputTokens: 20,
        partialOutputTokens: 10,
        partialInputCostUsd: 0.3,
        partialOutputCostUsd: 0.2,
      },
    };
    const next = applyFact(runningState(), fact, 200);
    expect(next.status).toBe("halted");
    expect(next.metrics.billedTokens).toBe(30);
    expect(next.metrics.totalCostUsd).toBeCloseTo(0.5, 10);
    expect(next.metrics.totalInputCostUsd).toBeCloseTo(0.3, 10);
    expect(next.metrics.totalOutputCostUsd).toBeCloseTo(0.2, 10);
    expect(next.metrics.nodeCosts["work"]).toEqual({ tokens: 30, costUsd: 0.5 });
  });
});

describe("v4 pause collapse — fact.run_paused reason discriminates the status", () => {
  test("reason:human → status='paused_human'", () => {
    const fact: FactEvent = {
      type: "fact.run_paused",
      payload: { reason: "human", nodeId: "ask", text: "Approve?", routes: ["yes", "no"] },
    };
    const next = applyFact(runningState(), fact, 200);
    expect(next.status).toBe("paused_human");
    expect(next.nodeStartedAt).toBeNull();
  });

  test("an auto-wake reason → status='paused_auto'", () => {
    const fact: FactEvent = {
      type: "fact.run_paused",
      payload: {
        reason: "provider_retry",
        nodeId: "work",
        httpStatus: 429,
        provider: "anthropic",
        errorMessage: "429",
        attempt: 1,
        resumeAt: 1_000,
      },
    };
    const next = applyFact(runningState(), fact, 200);
    expect(next.status).toBe("paused_auto");
  });

  test("an operator-action reason → status='paused'", () => {
    const fact: FactEvent = { type: "fact.run_paused", payload: { reason: "operator", nodeId: "work" } };
    const next = applyFact(runningState(), fact, 200);
    expect(next.status).toBe("paused");
  });
});
