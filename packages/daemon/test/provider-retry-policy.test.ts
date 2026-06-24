// Provider auto-retry policy unit tests.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { pbtRuns } from "../../../test/pbt-runs.ts";
import {
  computeBackoffMs,
  decideProviderRetry,
  isAutoRetryableStatus,
  PROVIDER_RETRY_BASE_BACKOFF_MS,
  PROVIDER_RETRY_MAX_ATTEMPTS,
  PROVIDER_RETRY_MAX_CUMULATIVE_MS,
  PROVIDER_RETRY_MAX_EXPONENTIAL_MS,
} from "../src/provider-retry-policy.ts";

describe("isAutoRetryableStatus", () => {
  test.each([
    [null, true], // pre-response network failure
    [408, true],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
    [504, true],
    [529, true], // Anthropic "overloaded"
    [400, false],
    [401, false],
    [402, false], // billing — manual stays
    [403, false],
    [404, false],
    [413, false],
    [422, false],
    [200, false],
  ] as Array<[number | null, boolean]>)("status=%s → autoRetryable=%s", (status, expected) => {
    expect(isAutoRetryableStatus(status)).toBe(expected);
  });
});

describe("decideProviderRetry — manual classes", () => {
  test("non-retryable status returns manual decision", () => {
    const d = decideProviderRetry({
      httpStatus: 401,
      priorAttempt: 0,
      now: 1_000_000,
      cumulativeDelayMs: 0,
    });
    expect(d.kind).toBe("manual");
  });

  test("402 (billing) is manual even though it could be transient", () => {
    const d = decideProviderRetry({
      httpStatus: 402,
      priorAttempt: 0,
      now: 1_000_000,
      cumulativeDelayMs: 0,
    });
    expect(d.kind).toBe("manual");
  });
});

describe("decideProviderRetry — auto-retry classes", () => {
  test("first 429 produces auto-retry attempt=1 with bounded delay", () => {
    const d = decideProviderRetry({
      httpStatus: 429,
      priorAttempt: 0,
      now: 1_000_000,
      cumulativeDelayMs: 0,
      random: () => 0.5,
    });
    expect(d.kind).toBe("auto-retry");
    if (d.kind !== "auto-retry") throw new Error();
    expect(d.attempt).toBe(1);
    expect(d.delayMs).toBeGreaterThanOrEqual(0);
    expect(d.delayMs).toBeLessThanOrEqual(PROVIDER_RETRY_BASE_BACKOFF_MS);
    expect(d.resumeAt).toBe(1_000_000 + d.delayMs);
  });

  test("subsequent attempts back off exponentially", () => {
    const random = () => 1; // always pick max jitter
    const d1 = decideProviderRetry({ httpStatus: 500, priorAttempt: 0, now: 0, cumulativeDelayMs: 0, random });
    const d3 = decideProviderRetry({ httpStatus: 500, priorAttempt: 2, now: 0, cumulativeDelayMs: 0, random });
    if (d1.kind !== "auto-retry" || d3.kind !== "auto-retry") throw new Error();
    expect(d3.delayMs).toBeGreaterThan(d1.delayMs);
  });

  test("Retry-After is honoured exactly with no jitter, no exponential cap", () => {
    const d = decideProviderRetry({
      httpStatus: 429,
      retryAfterMs: 60_000,
      priorAttempt: 0,
      now: 0,
      cumulativeDelayMs: 0,
      random: () => 0.5, // jitter ignored when Retry-After is present
    });
    expect(d.kind).toBe("auto-retry");
    if (d.kind !== "auto-retry") throw new Error();
    expect(d.delayMs).toBe(60_000);
  });

  test("Retry-After much larger than exponential cap is still honoured", () => {
    const d = decideProviderRetry({
      httpStatus: 429,
      retryAfterMs: 60 * 60 * 1000, // 1 hour
      priorAttempt: 0,
      now: 0,
      cumulativeDelayMs: 0,
    });
    if (d.kind !== "auto-retry") throw new Error();
    expect(d.delayMs).toBe(60 * 60 * 1000);
  });
});

describe("decideProviderRetry — exhaustion", () => {
  test("at the attempt cap returns exhausted with reason=max_attempts", () => {
    const d = decideProviderRetry({
      httpStatus: 429,
      priorAttempt: PROVIDER_RETRY_MAX_ATTEMPTS,
      now: 0,
      cumulativeDelayMs: 0,
    });
    expect(d.kind).toBe("exhausted");
    if (d.kind !== "exhausted") throw new Error();
    expect(d.reason).toBe("max_attempts");
    expect(d.attempt).toBe(PROVIDER_RETRY_MAX_ATTEMPTS + 1);
  });

  test("over cumulative-delay cap (without Retry-After) returns exhausted", () => {
    const d = decideProviderRetry({
      httpStatus: 500,
      priorAttempt: 1,
      now: 0,
      cumulativeDelayMs: 5 * 60 * 1000, // already at cap
      random: () => 1,
    });
    expect(d.kind).toBe("exhausted");
    if (d.kind !== "exhausted") throw new Error();
    expect(d.reason).toBe("max_cumulative_ms");
  });

  test("Retry-After bypasses cumulative-delay cap (provider knows best)", () => {
    const d = decideProviderRetry({
      httpStatus: 429,
      retryAfterMs: 30_000,
      priorAttempt: 1,
      now: 0,
      cumulativeDelayMs: 5 * 60 * 1000, // would otherwise exhaust
    });
    expect(d.kind).toBe("auto-retry");
  });
});

describe("decideProviderRetry — termination property", () => {
  // PROVIDER-RETRY-TERMINATION: over arbitrary auto-retryable transport
  // errors, the chain partitions deterministically — exhausted once the next
  // attempt exceeds the attempt cap, or once cumulative+next delay exceeds the
  // ms cap (no Retry-After); auto-retry strictly within both caps.
  test("PROVIDER-RETRY-TERMINATION: exhausts past the attempt cap or the cumulative-ms cap", () => {
    const random = () => 0.5;
    fc.assert(
      fc.property(
        fc.record({
          httpStatus: fc.constantFrom<number | null>(408, 429, 500, 502, 503, 504, 529, null),
          priorAttempt: fc.nat({ max: 20 }),
          now: fc.nat({ max: 2_000_000_000_000 }),
          cumulativeDelayMs: fc.nat({ max: 10 * 60 * 1000 }),
        }),
        ({ httpStatus, priorAttempt, now, cumulativeDelayMs }) => {
          const d = decideProviderRetry({ httpStatus, priorAttempt, now, cumulativeDelayMs, random });
          const nextAttempt = priorAttempt + 1;
          if (nextAttempt > PROVIDER_RETRY_MAX_ATTEMPTS) {
            expect(d.kind).toBe("exhausted");
            if (d.kind !== "exhausted") throw new Error();
            expect(d.reason).toBe("max_attempts");
            return;
          }
          // Same random ⇒ same per-attempt delay as the policy computed.
          const delayMs = computeBackoffMs({ attempt: nextAttempt, random });
          if (cumulativeDelayMs + delayMs > PROVIDER_RETRY_MAX_CUMULATIVE_MS) {
            expect(d.kind).toBe("exhausted");
            if (d.kind !== "exhausted") throw new Error();
            expect(d.reason).toBe("max_cumulative_ms");
          } else {
            expect(d.kind).toBe("auto-retry");
          }
        },
      ),
      { numRuns: pbtRuns(1000) },
    );
  });
});

describe("computeBackoffMs", () => {
  test("Retry-After is returned verbatim", () => {
    expect(computeBackoffMs({ retryAfterMs: 12_345, attempt: 4, random: () => 0.5 })).toBe(12_345);
  });

  test("full jitter is in [0, exponential_cap]", () => {
    const exponential = PROVIDER_RETRY_BASE_BACKOFF_MS * 2 ** 2; // attempt=3 → 4× base
    const min = computeBackoffMs({ attempt: 3, random: () => 0 });
    const max = computeBackoffMs({ attempt: 3, random: () => 0.999999 });
    expect(min).toBe(0);
    expect(max).toBeLessThan(exponential);
    expect(max).toBeGreaterThan(exponential * 0.9);
  });

  test("exponential is capped at PROVIDER_RETRY_MAX_EXPONENTIAL_MS", () => {
    const max = computeBackoffMs({ attempt: 100, random: () => 1 });
    expect(max).toBeLessThanOrEqual(PROVIDER_RETRY_MAX_EXPONENTIAL_MS);
  });
});
