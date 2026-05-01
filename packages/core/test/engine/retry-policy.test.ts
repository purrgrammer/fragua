// Property tests for retryStep — attractor §3.5 / §3.6.
//
// Invariants exercised:
//   1. Termination    — for any maxRetries=N, feeding "retry" repeatedly
//                       reaches halt in ≤N+1 steps (or advance_partial when
//                       allow_partial is set).
//   2. Counter monotonic — each "retry" action increments retries by exactly 1.
//   3. No overshoot   — retries never exceeds maxRetries after a retry step.
//   4. Success-like → advance — success / partial_success / skipped
//                       unconditionally advance, regardless of state.
//   5. Fail is terminal — status="fail" unconditionally returns fail,
//                       regardless of retries remaining.
//   6. non_retryable short-circuits any status to fail.
//   7. allow_partial converts retry-counter exhaustion to advance_partial
//      instead of halt.
//   8. Backoff math — delayForAttempt obeys the spec formula and clamps.
//   9. Presets — RETRY_PRESETS values match the attractor §3.6 table.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  type BackoffConfig,
  delayForAttempt,
  initialRetryState,
  isRetryPresetName,
  RETRY_PRESETS,
  type RetryState,
  retryStep,
} from "../../src/engine/retry-policy.ts";
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
          expect(retryStep({ state, status })).toEqual({ kind: "advance" });
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
        expect(retryStep({ state, status: "fail" })).toEqual({ kind: "fail" });
      }),
    );
  });
});

describe("retryStep — non_retryable short-circuit", () => {
  test("nonRetryable=true forces fail regardless of status", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        fc.constantFrom<OutcomeStatus>("success", "partial_success", "fail", "retry", "skipped"),
        (retries, maxRetries, status) => {
          const state: RetryState = { retries, maxRetries };
          expect(retryStep({ state, status, nonRetryable: true })).toEqual({ kind: "fail" });
        },
      ),
    );
  });
});

describe("retryStep — retry status", () => {
  test("retry below ceiling → retry with retries+1 and computed delayMs", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 1, max: 20 }), (maxRetries, room) => {
        const retries = Math.max(0, maxRetries - room);
        if (retries >= maxRetries) return;
        const action = retryStep({
          state: { retries, maxRetries },
          status: "retry",
          backoff: RETRY_PRESETS.standard,
        });
        expect(action.kind).toBe("retry");
        if (action.kind === "retry") {
          expect(action.next.retries).toBe(retries + 1);
          expect(action.next.maxRetries).toBe(maxRetries);
          expect(action.delayMs).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  test("retry at ceiling without allow_partial → halt", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (maxRetries) => {
        const action = retryStep({ state: { retries: maxRetries, maxRetries }, status: "retry" });
        expect(action).toEqual({ kind: "halt", reason: "max_retries_exceeded" });
      }),
    );
  });

  test("retry at ceiling with allow_partial → advance_partial (attractor §3.5)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (maxRetries) => {
        const action = retryStep({
          state: { retries: maxRetries, maxRetries },
          status: "retry",
          allowPartial: true,
        });
        expect(action).toEqual({ kind: "advance_partial" });
      }),
    );
  });

  test("retry without backoff config → delayMs=0 (none preset semantics)", () => {
    const action = retryStep({ state: { retries: 0, maxRetries: 3 }, status: "retry" });
    expect(action.kind).toBe("retry");
    if (action.kind === "retry") expect(action.delayMs).toBe(0);
  });
});

describe("retryStep — termination invariant", () => {
  test("feeding 'retry' repeatedly reaches halt within maxRetries+1 steps", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (maxRetries) => {
        let state = initialRetryState(maxRetries);
        let steps = 0;
        const bound = maxRetries + 2;
        while (steps < bound) {
          steps++;
          const action = retryStep({ state, status: "retry" });
          if (action.kind === "halt") {
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
});

describe("retryStep — fixed examples", () => {
  test("maxRetries=0 → first retry halts immediately", () => {
    expect(retryStep({ state: { retries: 0, maxRetries: 0 }, status: "retry" })).toEqual({
      kind: "halt",
      reason: "max_retries_exceeded",
    });
  });

  test("maxRetries=3 → exactly 3 retries allowed, 4th halts", () => {
    let state = initialRetryState(3);
    for (let i = 0; i < 3; i++) {
      const a = retryStep({ state, status: "retry" });
      expect(a.kind).toBe("retry");
      if (a.kind === "retry") state = a.next;
    }
    expect(retryStep({ state, status: "retry" })).toEqual({
      kind: "halt",
      reason: "max_retries_exceeded",
    });
  });
});

describe("delayForAttempt — backoff math (attractor §3.6)", () => {
  const noJitter: BackoffConfig = { initialDelayMs: 200, backoffFactor: 2, maxDelayMs: 60_000, jitter: false };

  test("attempt=1 → initialDelayMs", () => {
    expect(delayForAttempt(1, noJitter)).toBe(200);
  });

  test("attempt=2 → initialDelayMs * factor", () => {
    expect(delayForAttempt(2, noJitter)).toBe(400);
  });

  test("attempt=3 → initialDelayMs * factor²", () => {
    expect(delayForAttempt(3, noJitter)).toBe(800);
  });

  test("clamps to maxDelayMs", () => {
    const cfg: BackoffConfig = { initialDelayMs: 1000, backoffFactor: 10, maxDelayMs: 5_000, jitter: false };
    expect(delayForAttempt(5, cfg)).toBe(5_000);
  });

  test("jitter multiplies by [0.5, 1.5]", () => {
    const cfg: BackoffConfig = { ...noJitter, jitter: true };
    // Deterministic random=0 → 0.5x; random=0.999 → ~1.5x
    expect(delayForAttempt(1, cfg, () => 0)).toBeCloseTo(100, 0);
    expect(delayForAttempt(1, cfg, () => 0.999)).toBeGreaterThan(199);
    expect(delayForAttempt(1, cfg, () => 0.999)).toBeLessThanOrEqual(300);
  });

  test("invalid attempt → 0", () => {
    expect(delayForAttempt(0, noJitter)).toBe(0);
    expect(delayForAttempt(-1, noJitter)).toBe(0);
    expect(delayForAttempt(Number.NaN, noJitter)).toBe(0);
  });
});

describe("RETRY_PRESETS — attractor §3.6 table", () => {
  test("none has maxAttempts=1 and zero delays", () => {
    expect(RETRY_PRESETS.none).toEqual({
      maxAttempts: 1,
      initialDelayMs: 0,
      backoffFactor: 1,
      maxDelayMs: 0,
      jitter: false,
    });
  });

  test("standard delays: 200, 400, 800, 1600, 3200", () => {
    const cfg: BackoffConfig = {
      initialDelayMs: RETRY_PRESETS.standard.initialDelayMs,
      backoffFactor: RETRY_PRESETS.standard.backoffFactor,
      maxDelayMs: RETRY_PRESETS.standard.maxDelayMs,
      jitter: false,
    };
    expect(delayForAttempt(1, cfg)).toBe(200);
    expect(delayForAttempt(2, cfg)).toBe(400);
    expect(delayForAttempt(3, cfg)).toBe(800);
    expect(delayForAttempt(4, cfg)).toBe(1600);
    expect(delayForAttempt(5, cfg)).toBe(3200);
  });

  test("aggressive delays: 500, 1000, 2000, 4000, 8000", () => {
    const cfg: BackoffConfig = {
      initialDelayMs: RETRY_PRESETS.aggressive.initialDelayMs,
      backoffFactor: RETRY_PRESETS.aggressive.backoffFactor,
      maxDelayMs: RETRY_PRESETS.aggressive.maxDelayMs,
      jitter: false,
    };
    expect(delayForAttempt(1, cfg)).toBe(500);
    expect(delayForAttempt(5, cfg)).toBe(8000);
  });

  test("linear delays: constant 500", () => {
    const cfg: BackoffConfig = {
      initialDelayMs: RETRY_PRESETS.linear.initialDelayMs,
      backoffFactor: RETRY_PRESETS.linear.backoffFactor,
      maxDelayMs: RETRY_PRESETS.linear.maxDelayMs,
      jitter: false,
    };
    expect(delayForAttempt(1, cfg)).toBe(500);
    expect(delayForAttempt(2, cfg)).toBe(500);
    expect(delayForAttempt(3, cfg)).toBe(500);
  });

  test("patient delays: 2000, 6000, 18000", () => {
    const cfg: BackoffConfig = {
      initialDelayMs: RETRY_PRESETS.patient.initialDelayMs,
      backoffFactor: RETRY_PRESETS.patient.backoffFactor,
      maxDelayMs: RETRY_PRESETS.patient.maxDelayMs,
      jitter: false,
    };
    expect(delayForAttempt(1, cfg)).toBe(2000);
    expect(delayForAttempt(2, cfg)).toBe(6000);
    expect(delayForAttempt(3, cfg)).toBe(18000);
  });
});

describe("isRetryPresetName", () => {
  test("recognises preset names", () => {
    for (const name of Object.keys(RETRY_PRESETS)) {
      expect(isRetryPresetName(name)).toBe(true);
    }
  });

  test("rejects everything else", () => {
    expect(isRetryPresetName("typo")).toBe(false);
    expect(isRetryPresetName("")).toBe(false);
    expect(isRetryPresetName(null)).toBe(false);
    expect(isRetryPresetName(undefined)).toBe(false);
    expect(isRetryPresetName(42)).toBe(false);
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
