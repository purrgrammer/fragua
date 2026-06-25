// Provider auto-retry policy.
//
// Classifies LLM-provider transport errors into auto-retry vs manual,
// computes the next-attempt timestamp under a full-jitter exponential
// schedule (or honours the provider's `Retry-After` exactly when present),
// and bounds the chain to 5 attempts / 5 cumulative minutes — past either
// cap the run halts with `reason="provider_exhausted"` instead of
// burning more retries.
//
// The chain count survives manual `intent.resume` (the "continue chain"
// decision from the brainstorm): if an operator manually resumes after
// attempt 3 and the next call 429s, that's attempt 4. The chain resets
// only on a successful turn append (the executor clears
// `routing.internal.provider_retry.attempt` in the same transaction).
//
// Cost attribution under retries: `cost.recorded` only fires when a
// stream lands a successful AssistantMessage (see
// packages/agent/src/backend.ts). A retry that fails before any
// response → no cost.recorded → no double-charge in our ledger. If a
// future pi-ai change started emitting cost on transport failures,
// that invariant breaks; this comment exists so the next reader
// notices before it ships.

import { isAutoRetryableStatus, PROVIDER_RETRY_ATTEMPT_KEY } from "@fragua/core";

/** Re-exported from `@fragua/core` — the single source of truth for which
 * provider statuses auto-retry, shared with the agent backend's mid-stream
 * reclassification guard so the two can never silently diverge. */
export { isAutoRetryableStatus };

/** Routing key for the persisted attempt counter (survives manual resume so the
 * chain cap still bounds the run). Sourced from the typed-routing accessor
 * module (`@fragua/core`); re-exported so daemon-internal callers' import source
 * is stable. */
export { PROVIDER_RETRY_ATTEMPT_KEY };

export const PROVIDER_RETRY_MAX_ATTEMPTS = 5;
export const PROVIDER_RETRY_MAX_CUMULATIVE_MS = 5 * 60 * 1000;
export const PROVIDER_RETRY_BASE_BACKOFF_MS = 1_000;
export const PROVIDER_RETRY_MAX_EXPONENTIAL_MS = 32 * 1000;

export interface RetryDecision {
  kind: "auto-retry";
  attempt: number;
  delayMs: number;
  resumeAt: number;
}

export interface ManualDecision {
  kind: "manual";
}

export interface ExhaustedDecision {
  kind: "exhausted";
  attempt: number;
  reason: "max_attempts" | "max_cumulative_ms";
}

export type ProviderRetryDecision = RetryDecision | ManualDecision | ExhaustedDecision;

export interface DecideProviderRetryOpts {
  httpStatus: number | null;
  /** Provider's explicit `Retry-After` (ms). When set, honoured exactly
   * — no jitter, no exponential cap. The chain attempt counter still
   * applies (5 attempts max), but the per-attempt delay is whatever the
   * provider said. */
  retryAfterMs?: number;
  /** Prior attempt count from `routing.internal.provider_retry.attempt`.
   * `0` on the first failure within a chain. */
  priorAttempt: number;
  /** Wall-clock reference for `resumeAt`. */
  now: number;
  /** Cumulative delay already accrued in this chain. Used to bound to
   * `PROVIDER_RETRY_MAX_CUMULATIVE_MS`. The caller sums prior delays from
   * `fact.provider_retry_attempted` events (or carries the running
   * total in routing — TBD). For now the executor passes 0 and the
   * cap acts only on the per-attempt budget × max attempts. */
  cumulativeDelayMs: number;
  /** PRNG for full jitter — injectable for deterministic tests. */
  random?: () => number;
}

/**
 * Decide how to handle a `pause_provider` handler return.
 *
 * - Non-auto-retryable status → manual pause (operator decides).
 * - Auto-retryable but at/over chain cap → halt with `provider_exhausted`.
 * - Auto-retryable within cap → schedule retry with full-jitter exponential
 *   backoff (or the provider's Retry-After if present).
 */
export function decideProviderRetry(opts: DecideProviderRetryOpts): ProviderRetryDecision {
  if (!isAutoRetryableStatus(opts.httpStatus)) {
    return { kind: "manual" };
  }
  const nextAttempt = opts.priorAttempt + 1;
  if (nextAttempt > PROVIDER_RETRY_MAX_ATTEMPTS) {
    return { kind: "exhausted", attempt: nextAttempt, reason: "max_attempts" };
  }
  const delayMs = computeBackoffMs({
    ...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
    attempt: nextAttempt,
    // The executor's transition-planner always injects a deterministic `random`;
    // this fallback only serves direct unit callers.
    // decision-core-allow: injection seam for randomness
    random: opts.random ?? Math.random,
  });
  if (opts.cumulativeDelayMs + delayMs > PROVIDER_RETRY_MAX_CUMULATIVE_MS && opts.retryAfterMs === undefined) {
    return { kind: "exhausted", attempt: nextAttempt, reason: "max_cumulative_ms" };
  }
  return {
    kind: "auto-retry",
    attempt: nextAttempt,
    delayMs,
    resumeAt: opts.now + delayMs,
  };
}

/**
 * Backoff calculation:
 *   - With `retryAfterMs`: honour exactly. No jitter, no exponential cap.
 *     Provider knows their state better than we do; if they say wait an
 *     hour, wait an hour. Operator can manually resume earlier.
 *   - Without: full jitter exponential, capped at
 *     `PROVIDER_RETRY_MAX_EXPONENTIAL_MS` per attempt. Full jitter
 *     desynchronises racing daemons even though we're single-daemon
 *     today; the property generalises.
 */
export function computeBackoffMs(opts: { retryAfterMs?: number; attempt: number; random: () => number }): number {
  if (opts.retryAfterMs !== undefined) return opts.retryAfterMs;
  const exponentialMs = Math.min(
    PROVIDER_RETRY_BASE_BACKOFF_MS * 2 ** (opts.attempt - 1),
    PROVIDER_RETRY_MAX_EXPONENTIAL_MS,
  );
  return Math.floor(opts.random() * exponentialMs);
}
