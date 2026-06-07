// Handler invocation — the single effect boundary where a node's handler runs.
//
// Owns the two effects that wrap the call: registering the steer controller in
// the abort registry (so operator intents / shutdown can abort the in-flight
// handler) and the leak-detection watchdog (a handler that ignores its
// AbortSignal past `maxMs + leakGrace` is "leaked"). Returns a structured
// outcome — normal result, watchdog leak, or a thrown error tagged with whether
// it looked like an abort by name — and leaves interpretation (abort-cause
// classification, reactive-budget reclassification, fact mapping) to the
// caller, which holds the per-turn signal + budget state.
//
// This is the seam a fault-injecting PBT harness substitutes to model
// "handler throws / hangs (leak) / aborts" without running a real handler.

import type * as core from "@fragua/core/handler";
import type { AbortRegistry } from "./abort-registry.ts";
import { isAbortError, TIMEOUT_SENTINEL } from "./executor-helpers.ts";

export type HandlerInvocation =
  | { kind: "result"; result: core.HandlerResult }
  /** The watchdog tripped: the handler ignored its AbortSignal past
   * `maxMs + leakGrace`. The caller emits fact.handler_timeout_leaked. */
  | { kind: "leak" }
  /** The handler (or a build step inside the awaited call) threw.
   * `abortByName` is true when the error name is AbortError / TimeoutError;
   * the caller may still reclassify (e.g. a reactive-budget abort surfaced
   * as a plain Error). */
  | { kind: "thrown"; error: unknown; abortByName: boolean };

export async function invokeHandler(deps: {
  spec: core.HandlerSpec;
  ctx: core.HandlerContext;
  registry: AbortRegistry;
  runId: string;
  /** The steer controller already merged into `ctx.signal`; registered so
   * operator abort/steer can trip the in-flight handler. */
  steerCtrl: AbortController;
  leakGraceMs: number;
}): Promise<HandlerInvocation> {
  const { spec, ctx, registry, runId, steerCtrl, leakGraceMs } = deps;
  // Tracked so it can be cleared once the handler wins the race — an
  // un-cleared `setTimeout(maxMs + leakGrace)` would otherwise survive every
  // bounded dispatch and keep the event loop (and tests' fake timers) populated.
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  // Register only here, not at steerCtrl creation: the caller's build steps
  // (graph load, context build) can throw, and the `finally` is the sole
  // dispose. `register` returns a disposer that removes exactly this entry, so
  // concurrent fan-out branches on one run don't clobber each other.
  const disposeRegistration = registry.register(runId, steerCtrl);
  try {
    // Promise.race against a sentinel rather than a rejecting timer: a
    // rejection would mask an ignored-AbortSignal as a "handler error". A
    // resolved sentinel lets us detect the leak unambiguously.
    if (spec.maxMs !== undefined) {
      const watchdogMs = spec.maxMs + leakGraceMs;
      const raced = await Promise.race<core.HandlerResult | typeof TIMEOUT_SENTINEL>([
        spec.handler(ctx),
        new Promise<typeof TIMEOUT_SENTINEL>((res) => {
          watchdogTimer = setTimeout(() => res(TIMEOUT_SENTINEL), watchdogMs);
        }),
      ]);
      if (raced === TIMEOUT_SENTINEL) return { kind: "leak" };
      return { kind: "result", result: raced };
    }
    // Unbounded llm (`max_ms=0`): no AbortSignal.timeout in the merged signal,
    // so no leak watchdog either — cost/token bounds and operator intents are
    // the operative ceiling. Steer + shutdown still abort via `ctx.signal`.
    return { kind: "result", result: await spec.handler(ctx) };
  } catch (err) {
    return { kind: "thrown", error: err, abortByName: isAbortError(err) };
  } finally {
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
    disposeRegistration();
  }
}
