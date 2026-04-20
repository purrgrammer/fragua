// Property tests for retryStep — attractor §3.6 / §5.2 backward-edge bound.
//
// Invariants exercised:
//   1. Termination    — for any maxRetries=N, feeding "retry" repeatedly
//                       reaches halt in ≤N+1 steps.
//   2. Counter monotonic — each "retry" action increments retries by exactly 1.
//   3. No overshoot   — retries never exceeds maxRetries after a retry step.
//   4. Success-like → advance — success / partial_success / skipped
//                       unconditionally advance, regardless of state.
//   5. Fail is terminal — status="fail" unconditionally returns fail,
//                       regardless of retries remaining.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { initialRetryState, type RetryState, retryStep } from "../../src/engine/retry-policy.ts";
import type { OutcomeStatus } from "../../src/types/outcome.ts";

const SUCCESS_LIKE: OutcomeStatus[] = ["success", "partial_success", "skipped"];

describe("retryStep — success-like statuses", () => {
  test("success / partial_success / skipped → advance from any state", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        fc.constantFrom(...SUCCESS_LIKE),
        (retries, maxRetries, status) => {
          const state: RetryState = { retries, maxRetries };
          expect(retryStep(state, status)).toEqual({ kind: "advance" });
        },
      ),
    );
  });
});

describe("retryStep — fail status", () => {
  test("fail → fail from any state", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 20 }), (retries, maxRetries) => {
        const state: RetryState = { retries, maxRetries };
        expect(retryStep(state, "fail")).toEqual({ kind: "fail" });
      }),
    );
  });
});

describe("retryStep — retry status", () => {
  test("retry below ceiling → retry with retries+1", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 1, max: 20 }), (maxRetries, room) => {
        // Pick a `retries` value strictly below `maxRetries`.
        const retries = Math.max(0, maxRetries - room);
        if (retries >= maxRetries) return; // guard
        const action = retryStep({ retries, maxRetries }, "retry");
        expect(action.kind).toBe("retry");
        if (action.kind === "retry") {
          expect(action.next.retries).toBe(retries + 1);
          expect(action.next.maxRetries).toBe(maxRetries);
        }
      }),
    );
  });

  test("retry at ceiling → halt(max_retries_exceeded)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (maxRetries) => {
        const action = retryStep({ retries: maxRetries, maxRetries }, "retry");
        expect(action).toEqual({ kind: "halt", reason: "max_retries_exceeded" });
      }),
    );
  });

  test("retry above ceiling (shouldn't happen but reducer stays defensive) → halt", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 1, max: 10 }), (maxRetries, overshoot) => {
        const action = retryStep({ retries: maxRetries + overshoot, maxRetries }, "retry");
        expect(action.kind).toBe("halt");
      }),
    );
  });
});

describe("retryStep — termination invariant", () => {
  test("feeding 'retry' repeatedly reaches halt within maxRetries+1 steps", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (maxRetries) => {
        let state = initialRetryState(maxRetries);
        let steps = 0;
        const bound = maxRetries + 2; // +1 is the spec bound; +2 catches off-by-one
        while (steps < bound) {
          steps++;
          const action = retryStep(state, "retry");
          if (action.kind === "halt") {
            // Must halt in exactly maxRetries+1 steps (the N+1th retry is the one that halts).
            expect(steps).toBe(maxRetries + 1);
            return;
          }
          if (action.kind !== "retry") {
            throw new Error(`unexpected action kind for retry status: ${action.kind}`);
          }
          state = action.next;
        }
        throw new Error(`did not halt within ${bound} steps for maxRetries=${maxRetries}`);
      }),
    );
  });

  test("retries never exceeds maxRetries after any sequence of success-like + retry steps", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 }),
        fc.array(fc.constantFrom<OutcomeStatus>("retry", "success", "partial_success", "skipped"), {
          minLength: 0,
          maxLength: 30,
        }),
        (maxRetries, sequence) => {
          let state = initialRetryState(maxRetries);
          for (const status of sequence) {
            const action = retryStep(state, status);
            if (action.kind === "retry") {
              state = action.next;
              expect(state.retries).toBeLessThanOrEqual(maxRetries);
            } else if (action.kind === "halt") {
              return; // reducer stopped; invariant held up to here
            }
            // advance/fail leave state untouched for the next iteration.
          }
          // Never overshoots.
          expect(state.retries).toBeLessThanOrEqual(maxRetries);
        },
      ),
    );
  });
});

describe("retryStep — fixed examples anchoring semantics", () => {
  test("maxRetries=0 → first retry halts immediately", () => {
    expect(retryStep({ retries: 0, maxRetries: 0 }, "retry")).toEqual({
      kind: "halt",
      reason: "max_retries_exceeded",
    });
  });

  test("maxRetries=3 → exactly 3 retries allowed, 4th halts", () => {
    let state = initialRetryState(3);
    for (let i = 0; i < 3; i++) {
      const a = retryStep(state, "retry");
      expect(a.kind).toBe("retry");
      if (a.kind === "retry") state = a.next;
    }
    expect(retryStep(state, "retry")).toEqual({
      kind: "halt",
      reason: "max_retries_exceeded",
    });
  });

  test("success resets nothing — the reducer doesn't track history across advances", () => {
    // §5.2 says outcome=success "resets the retry counter" at the graph
    // level, but that reset happens when the executor moves to a new node
    // and constructs fresh retry state for it. The reducer itself just
    // says "advance" — stateless across nodes.
    const state: RetryState = { retries: 2, maxRetries: 3 };
    expect(retryStep(state, "success")).toEqual({ kind: "advance" });
  });
});

describe("initialRetryState", () => {
  test("clamps negative maxRetries to 0", () => {
    expect(initialRetryState(-5)).toEqual({ retries: 0, maxRetries: 0 });
  });

  test("floors fractional maxRetries", () => {
    expect(initialRetryState(2.9)).toEqual({ retries: 0, maxRetries: 2 });
  });
});
