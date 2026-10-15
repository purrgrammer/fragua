/** The error a handler throws when `ctx.signal` aborted it. Named `AbortError`
 * so the executor classifies the exit by the signal's cause (timeout, shutdown,
 * operator abort) instead of treating it as a thrown-error halt. */
export function abortError(message = "aborted"): Error {
  return Object.assign(new Error(message), { name: "AbortError" });
}
