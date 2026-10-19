// Pure lifecycle-fact planners — the run_paused{operator} / run_started /
// dispatch_started / executor-crash facts the driver used to build inline. No
// store, clock, or randomness: every case is a plain input → plan assertion.

import { describe, expect, test } from "bun:test";
import type { FactEvent } from "@fragua/store";
import {
  CRASH_HALT_MINIMAL_DETAIL,
  planCrashHalt,
  planCrashHaltMinimal,
  planDispatchStarted,
  planOccExhausted,
  planOperatorPause,
  planRunStarted,
} from "../src/lifecycle-planner.ts";

describe("planOperatorPause", () => {
  test("emits run_paused{reason:operator} at the current node", () => {
    expect(planOperatorPause({ nodeId: "review" }).facts).toEqual([
      { type: "fact.run_paused", payload: { reason: "operator", nodeId: "review" } },
    ]);
  });
});

describe("planRunStarted", () => {
  test("stamps baseGitSha / baseGitRef when present", () => {
    expect(
      planRunStarted({
        workflowSha: "wf1",
        contractVersion: 4,
        startNode: "start",
        baseGitSha: "abc123",
        baseGitRef: "main",
      }).facts,
    ).toEqual([
      {
        type: "fact.run_started",
        payload: {
          workflowSha: "wf1",
          contractVersion: 4,
          startNode: "start",
          baseGitSha: "abc123",
          baseGitRef: "main",
        },
      },
    ]);
  });

  test("omits baseGitSha / baseGitRef when absent", () => {
    expect(planRunStarted({ workflowSha: "wf1", contractVersion: 4, startNode: "start" }).facts).toEqual([
      { type: "fact.run_started", payload: { workflowSha: "wf1", contractVersion: 4, startNode: "start" } },
    ]);
  });
});

describe("planDispatchStarted", () => {
  test("omits pass at 0 and carries resumeOf", () => {
    expect(planDispatchStarted({ nodeId: "n1", iteration: 2, pass: 0, resumeOf: "fresh" }).facts).toEqual([
      { type: "fact.dispatch_started", payload: { nodeId: "n1", iteration: 2, resumeOf: "fresh" } },
    ]);
  });

  test("stamps pass when > 0", () => {
    expect(planDispatchStarted({ nodeId: "n1", iteration: 0, pass: 3, resumeOf: "paused" }).facts).toEqual([
      { type: "fact.dispatch_started", payload: { nodeId: "n1", iteration: 0, pass: 3, resumeOf: "paused" } },
    ]);
  });
});

describe("planCrashHalt", () => {
  test("emits a handler-agnostic run_terminated{errored} with the driver's detail", () => {
    expect(planCrashHalt({ detail: "executor crashed at n1: boom" }).facts).toEqual([
      {
        type: "fact.run_terminated",
        payload: { status: "errored", reason: "error", detail: "executor crashed at n1: boom" },
      },
    ]);
  });

  test("planCrashHalt clips an oversized detail", () => {
    const [fact] = planCrashHalt({ detail: `executor crashed at n1: ${"x".repeat(10_000)}` }).facts;
    expect(new TextEncoder().encode(JSON.stringify(fact?.payload)).length).toBeLessThan(4096);
    expect((fact?.payload as { detail: string }).detail.startsWith("executor crashed at n1: ")).toBe(true);
  });

  test("planCrashHaltMinimal carries the fixed detail", () => {
    expect(planCrashHaltMinimal().facts).toEqual([
      {
        type: "fact.run_terminated",
        payload: { status: "errored", reason: "error", detail: CRASH_HALT_MINIMAL_DETAIL },
      },
    ]);
  });
});

describe("spend-leading terminals", () => {
  const spend: FactEvent[] = [
    {
      type: "fact.node_aborted",
      payload: { nodeId: "n1", iteration: 0, cause: "crash", partialTokens: 100, partialCostUsd: 0.25 },
    },
  ];

  test("planCrashHalt and planOccExhausted lead with the given spend facts", () => {
    const crash = planCrashHalt({ detail: `executor crashed at n1: ${"x".repeat(10_000)}`, spend }).facts;
    const minimal = planCrashHaltMinimal({ spend }).facts;
    const occ = planOccExhausted({
      count: 3,
      nodeId: "n1",
      iteration: 0,
      lastVersion: 7,
      attemptedFactType: "fact.node_completed",
      spend,
    }).facts;
    for (const facts of [crash, minimal, occ]) {
      expect(facts.slice(0, -1)).toEqual(spend);
      expect(facts[facts.length - 1]?.type).toBe("fact.run_terminated");
      expect(new TextEncoder().encode(JSON.stringify(facts[facts.length - 1]?.payload)).length).toBeLessThan(4096);
    }
    expect(occ[1]?.payload).toMatchObject({
      status: "errored",
      reason: "occ_exhausted",
      occContext: { count: 3, nodeId: "n1", iteration: 0, lastVersion: 7, attemptedFactType: "fact.node_completed" },
    });
  });
});
