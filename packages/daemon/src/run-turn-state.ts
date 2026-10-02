// Explicit per-run turn state — the mutable locals that once lived as closure
// variables inside `runOneInner`. One record is created per `runOne` pass
// (`create()`) and threaded by reference through the dispatch / fan-out
// functions, which mutate it through the small updaters below. This replaces
// the closure so those functions can be top-level (dispatch-turn.ts,
// fanout.ts) rather than nested. Pure data + pure transitions: no store handle,
// no clock, no I/O — guarded by decision-core-discipline.test.ts (this file is
// NOT on its IO_ALLOWED list).

import type { ExecutionEnvironment, Graph, OutputsValue } from "@fragua/core";
import type { FactEvent, RunState } from "@fragua/store";

export interface RunTurnState {
  /** Consecutive handler aborts on the current linear node. Reset on any
   * non-abort handler return; drives the `abort_loop` ceiling. */
  consecutiveAborts: number;
  /** Per-branch abort streak under a fan-out, keyed by sub-node id. */
  branchAborts: Map<string, number>;
  /** A fan-out park/terminal disposition whose commit lost its OCC race —
   * parked for re-commit at the next `runFanout` entry. */
  pendingFanoutDisposition: FactEvent[] | undefined;
  /** Turns taken this pass (test-only ceiling). */
  turns: number;
  /** Handler dispatches counted for the `max_loops` ceiling. */
  dispatches: number;
  /** Provisioned per-run execution environment, cached after first `ensure`. */
  runEnv: ExecutionEnvironment | undefined;
  /** Lazy per-run graph cache (parsed once on first edge-selection need). */
  cachedGraph: Graph | null;
  /** The workflow row exists but won't parse (only this halts the run). */
  workflowUnparseable: boolean;
  workflowParseError: string | undefined;
  /** Lazy per-run outputs cache; invalidated when a committed fact carries
   * fresh `outputs`. */
  cachedOutputs: Record<string, OutputsValue> | undefined;
  outputsCacheValid: boolean;
  /** The post-commit `run_state` from the most recent `commitFanoutFact` —
   * the fan-out budget gate reuses it instead of re-reading. */
  lastFanoutState: RunState | undefined;
  /** Soft budget-warn tags accrued this fan-out run, pending a durable fold
   * into routing (drained onto the next commit by `commitFanoutFact`). */
  pendingWarnTags: Set<string>;
}

/** A fresh per-run turn state. */
export function create(): RunTurnState {
  return {
    consecutiveAborts: 0,
    branchAborts: new Map<string, number>(),
    pendingFanoutDisposition: undefined,
    turns: 0,
    dispatches: 0,
    runEnv: undefined,
    cachedGraph: null,
    workflowUnparseable: false,
    workflowParseError: undefined,
    cachedOutputs: undefined,
    outputsCacheValid: false,
    lastFanoutState: undefined,
    pendingWarnTags: new Set<string>(),
  };
}

/** Bump the consecutive-abort streak for the linear path. */
export function recordAbort(state: RunTurnState): void {
  state.consecutiveAborts += 1;
}

/** Reset the consecutive-abort streak (the handler made progress). */
export function resetAborts(state: RunTurnState): void {
  state.consecutiveAborts = 0;
}

/** Count one handler dispatch against the `max_loops` ceiling. */
export function countDispatch(state: RunTurnState): void {
  state.dispatches += 1;
}

/** Climb a fan-out branch's own abort streak (masking-bug guard). */
export function bumpBranchAbort(state: RunTurnState, nodeId: string): void {
  state.branchAborts.set(nodeId, (state.branchAborts.get(nodeId) ?? 0) + 1);
}

/** Clear a fan-out branch's abort streak after it settles cleanly. */
export function clearBranchAbort(state: RunTurnState, nodeId: string): void {
  state.branchAborts.delete(nodeId);
}
