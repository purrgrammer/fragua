// Provider HTTP-status classification — the single source of truth for
// which LLM-provider transport statuses are auto-retryable vs manual.
//
// Imported by BOTH the daemon's retry policy (the actual retry decision)
// and the agent backend's mid-stream reclassification guard, so the two
// can never silently diverge.

/** Anthropic's non-standard "overloaded" status. Transient, auto-retryable. */
export const ANTHROPIC_OVERLOADED_STATUS = 529;

/**
 * Classify an HTTP status (or `null` for pre-response failures like
 * DNS/TCP) into auto-retry vs manual. The unknown classes default to
 * manual — better to surface a new failure mode to the operator than
 * silently retry on a status we haven't analysed.
 *
 * Auto-retryable: 408, 429, 500–504, 529 (Anthropic "overloaded"),
 * pre-response network failures (`httpStatus === null`).
 *
 * Manual: 400, 401, 402, 403, 404, 413, 422 — none of these are
 * fixable by retrying without operator intervention (auth rotated,
 * model gone, payload too large, billing failure, schema mismatch).
 */
export function isAutoRetryableStatus(httpStatus: number | null): boolean {
  if (httpStatus === null) return true;
  if (httpStatus === 408 || httpStatus === 429 || httpStatus === ANTHROPIC_OVERLOADED_STATUS) return true;
  if (httpStatus >= 500 && httpStatus <= 504) return true;
  return false;
}
