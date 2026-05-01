// Retry-policy reducer — attractor-spec §3.5 and §3.6.
//
// Attractor has no loop primitive. Loops are backward edges, and iteration
// is bounded by `max_retries` on the target node. Outcome semantics:
//
//   success / partial_success / skipped → advance (take successor edge)
//   retry                                → re-enter current node; counter++,
//                                          delay computed from BackoffConfig
//   fail                                 → fail (routing finds a fail edge
//                                           or the run terminates)
//
// `non_retryable` (Outcome flag) short-circuits any retry: handlers that
// know the failure is terminal (4xx, auth, validation) set it and the
// reducer treats the outcome as fail regardless of status.
//
// `allow_partial` (node attr) converts a retry-counter exhaustion into a
// PARTIAL_SUCCESS advance instead of a halt — attractor §3.5 calls for this
// path explicitly. Without `allow_partial=true` exhaustion still halts.
//
// This module is the pure reducer the executor consults. The executor still
// owns actually RE-EXECUTING the node, but the question "should we?" is
// answered here — so property tests can exercise termination without any
// sqlite, worker pool, or async machinery.

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
  /** Retry exhaustion + `allow_partial=true` — advance carrying PARTIAL_SUCCESS
   * instead of halting (attractor §3.5). The caller rewrites the outcome
   * status accordingly so downstream goal-gate checks accept the result. */
  | { kind: "advance_partial" }
  /** Re-enter the same node after `delayMs`. Caller uses `next` as the new
   * state. The delay is computed by `delayForAttempt(attempt, BackoffConfig)`;
   * a `none` preset (or a node with no policy) returns `delayMs=0`. */
  | { kind: "retry"; next: RetryState; delayMs: number }
  /** Node failed; caller routes via a `condition="outcome=fail"` edge or
   * terminates the run if none exists. */
  | { kind: "fail" }
  /** Retry would exceed `maxRetries`; caller halts the run. */
  | { kind: "halt"; reason: "max_retries_exceeded" };

/** Backoff configuration for retry delays. Defaults match attractor §3.6. */
export interface BackoffConfig {
  /** First retry delay in milliseconds. Default 200. */
  initialDelayMs: number;
  /** Multiplier applied to subsequent delays. Default 2.0 (exponential). */
  backoffFactor: number;
  /** Cap on the computed delay before jitter. Default 60_000. */
  maxDelayMs: number;
  /** Add ±50% random jitter to the capped delay. Default true. */
  jitter: boolean;
}

/** Default backoff: 200ms initial × 2.0 factor, capped at 60s, jittered. */
export const DEFAULT_BACKOFF: BackoffConfig = {
  initialDelayMs: 200,
  backoffFactor: 2.0,
  maxDelayMs: 60_000,
  jitter: true,
};

/** Five named retry presets (attractor §3.6). `maxAttempts` includes the
 * initial execution (max_attempts = max_retries + 1). */
export const RETRY_PRESETS = {
  none: { maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0, jitter: false },
  standard: { maxAttempts: 5, initialDelayMs: 200, backoffFactor: 2, maxDelayMs: 60_000, jitter: true },
  aggressive: { maxAttempts: 5, initialDelayMs: 500, backoffFactor: 2, maxDelayMs: 60_000, jitter: true },
  linear: { maxAttempts: 3, initialDelayMs: 500, backoffFactor: 1, maxDelayMs: 500, jitter: false },
  patient: { maxAttempts: 3, initialDelayMs: 2000, backoffFactor: 3, maxDelayMs: 60_000, jitter: true },
} as const;

export type RetryPresetName = keyof typeof RETRY_PRESETS;

export function isRetryPresetName(value: unknown): value is RetryPresetName {
  return typeof value === "string" && value in RETRY_PRESETS;
}

/** Compute the delay for a given retry attempt number (1-indexed). The
 * first retry is `attempt=1`. Jitter, when enabled, multiplies the capped
 * delay by `[0.5, 1.5]`. Tests pass a deterministic `random` to verify
 * the formula without flake. */
export function delayForAttempt(attempt: number, cfg: BackoffConfig, random: () => number = Math.random): number {
  if (attempt < 1 || !Number.isFinite(attempt)) return 0;
  const raw = cfg.initialDelayMs * cfg.backoffFactor ** (attempt - 1);
  const capped = Math.min(raw, cfg.maxDelayMs);
  if (!cfg.jitter) return capped;
  return capped * (0.5 + random());
}

export interface RetryStepInput {
  state: RetryState;
  status: OutcomeStatus;
  /** Backoff for this node. Resolved upstream from preset name + custom
   * overrides (attr-resolution lives in the executor / dispatcher, not
   * the reducer). When omitted, retries use 0ms — equivalent to the
   * `none` preset's backoff. */
  backoff?: BackoffConfig;
  /** Outcome's `non_retryable` flag — handlers set it on auth/4xx/validation
   * errors. Forces the reducer to treat the outcome as fail regardless of
   * status. */
  nonRetryable?: boolean;
  /** Node's `allow_partial` attr — converts retry-counter exhaustion to
   * PARTIAL_SUCCESS advance instead of halt (attractor §3.5). */
  allowPartial?: boolean;
}

export function retryStep(input: RetryStepInput): RetryAction {
  const { state, status } = input;

  // Non-retryable short-circuit — even an explicit "retry" status fails
  // immediately when the boundary marked the failure terminal.
  if (input.nonRetryable === true) return { kind: "fail" };

  if (status === "success" || status === "partial_success" || status === "skipped") {
    return { kind: "advance" };
  }
  if (status === "fail") {
    return { kind: "fail" };
  }
  // status === "retry"
  if (state.retries >= state.maxRetries) {
    if (input.allowPartial === true) return { kind: "advance_partial" };
    return { kind: "halt", reason: "max_retries_exceeded" };
  }
  const cfg = input.backoff ?? RETRY_PRESETS.none;
  const delayMs = delayForAttempt(state.retries + 1, {
    initialDelayMs: cfg.initialDelayMs,
    backoffFactor: cfg.backoffFactor,
    maxDelayMs: cfg.maxDelayMs,
    jitter: cfg.jitter,
  });
  return {
    kind: "retry",
    next: { retries: state.retries + 1, maxRetries: state.maxRetries },
    delayMs,
  };
}

/** Starting state for a node's first entry. */
export function initialRetryState(maxRetries: number): RetryState {
  return { retries: 0, maxRetries: Math.max(0, Math.floor(maxRetries)) };
}
