// Retry-policy reducer — attractor-spec §3.6 and §5.2.
//
// Attractor has no loop primitive. Loops are backward edges, and iteration
// is bounded by `max_retries` on the target node. Outcome semantics:
//
//   success / partial_success / skipped → advance (take successor edge)
//   retry                                → re-enter current node; counter++
//   fail                                 → fail (routing finds a fail edge
//                                           or the run terminates)
//
// This module is the pure reducer the executor consults. The executor still
// owns actually RE-EXECUTING the node, but the question "should we?" is
// answered here — so property tests can exercise termination without any
// sqlite, worker pool, or async machinery.
//
// Invariant (property-tested in retry-policy.test.ts): given a state with
// `maxRetries = N`, feeding the reducer a sequence of "retry" outcomes
// reaches `halt` in at most N+1 steps. N=0 means the very first retry halts.

import type { OutcomeStatus } from "../types/outcome.ts";

export interface RetryState {
  /** How many times this node has already been re-entered after a non-terminal
   * outcome. Starts at 0 on first entry. */
  retries: number;
  /** Ceiling from `node.attrs.max_retries`. 0 means no retries permitted. */
  maxRetries: number;
}

export type RetryAction =
  /** Proceed to edge selection. */
  | { kind: "advance" }
  /** Re-enter the same node; caller uses the returned `next` as the new state
   * for the next invocation. */
  | { kind: "retry"; next: RetryState }
  /** Node failed; caller routes via a `condition="outcome=fail"` edge or
   * terminates the run if none exists. */
  | { kind: "fail" }
  /** Retry would exceed `maxRetries`; caller halts the run. */
  | { kind: "halt"; reason: "max_retries_exceeded" };

export function retryStep(state: RetryState, status: OutcomeStatus): RetryAction {
  if (status === "success" || status === "partial_success" || status === "skipped") {
    return { kind: "advance" };
  }
  if (status === "fail") {
    return { kind: "fail" };
  }
  // status === "retry"
  if (state.retries >= state.maxRetries) {
    return { kind: "halt", reason: "max_retries_exceeded" };
  }
  return { kind: "retry", next: { retries: state.retries + 1, maxRetries: state.maxRetries } };
}

/** Starting state for a node's first entry. */
export function initialRetryState(maxRetries: number): RetryState {
  return { retries: 0, maxRetries: Math.max(0, Math.floor(maxRetries)) };
}
