// Pure lifecycle-fact planners — the driver-side twin of transition-planner.ts
// / abort-planner.ts / predispatch-planner.ts, for the run-lifecycle facts the
// executor emits AROUND a dispatch: the operator pause, the first `run_started`,
// the per-dispatch `dispatch_started` marker, and the executor-crash terminal.
// Each was inline in the driver; lifting the fact choice here keeps SPEC §3.11 /
// I12's decision core complete — no store, no clock, no RNG. The driver resolves
// the values (graph goal / steer routing, `resumeOf`, crash detail) and applies
// the plan.

import type { FactEvent } from "@fragua/store";
import { passField, type ResumeOf } from "./executor-helpers.ts";

export interface LifecyclePlan {
  facts: FactEvent[];
}

/** The operator-pause fact for a running run an operator paused (R1). */
export function planOperatorPause(input: { nodeId: string }): LifecyclePlan {
  return { facts: [{ type: "fact.run_paused", payload: { reason: "operator", nodeId: input.nodeId } }] };
}

/** The first `run_started` fact on a just-claimed run. The driver assembles the
 * routing patch (graph goal / steer / deferred-pause seeding) separately; this
 * is only the fact. `baseGitSha` / `baseGitRef` are stamped when the driver
 * resolved them from the worktree env. */
export function planRunStarted(input: {
  workflowSha: string;
  contractVersion: number;
  startNode: string;
  baseGitSha?: string;
  baseGitRef?: string;
}): LifecyclePlan {
  return {
    facts: [
      {
        type: "fact.run_started",
        payload: {
          workflowSha: input.workflowSha,
          contractVersion: input.contractVersion,
          startNode: input.startNode,
          ...(input.baseGitSha != null ? { baseGitSha: input.baseGitSha } : {}),
          ...(input.baseGitRef != null ? { baseGitRef: input.baseGitRef } : {}),
        },
      },
    ],
  };
}

/** The per-dispatch `dispatch_started` marker. `resumeOf` is derived by the
 * driver (a store read); `pass` is stamped only when > 0 (via `passField`). */
export function planDispatchStarted(input: {
  nodeId: string;
  iteration: number;
  pass: number;
  resumeOf: ResumeOf;
}): LifecyclePlan {
  return {
    facts: [
      {
        type: "fact.dispatch_started",
        payload: {
          nodeId: input.nodeId,
          iteration: input.iteration,
          ...passField(input.pass),
          resumeOf: input.resumeOf,
        },
      },
    ],
  };
}

/** The executor-crash terminal — the outer safety net when the run body escaped
 * without terminalising. `detail` carries the node + error message the driver
 * assembled. */
export function planCrashHalt(input: { detail: string }): LifecyclePlan {
  return {
    facts: [{ type: "fact.run_terminated", payload: { status: "errored", reason: "error", detail: input.detail } }],
  };
}
