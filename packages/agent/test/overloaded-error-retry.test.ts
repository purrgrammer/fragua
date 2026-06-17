// Anthropic `overloaded_error` mid-stream misclassification.
//
// Anthropic's overload can arrive mid-stream: the HTTP response already
// returned 200 (so `onResponse` captures `lastHttpStatus = 200`), and the
// overload then surfaces as an `error` event in the stream body whose
// envelope is `{"type":"error","error":{"type":"overloaded_error",...}}`.
//
// An `overloaded_error` is transient and auto-retryable — it should pause
// as `provider_retry` (paused_auto) and wake on the backoff timer, exactly
// like a 529. The backend normalises the effective status to the canonical
// 529 so the status-only classifier auto-retries it.

import { describe, expect, test } from "bun:test";
import { decideProviderRetry } from "../../daemon/src/provider-retry-policy.ts";
import { ANTHROPIC_OVERLOADED_STATUS, effectiveProviderHttpStatus, isOverloadedErrorMessage } from "../src/backend.ts";

describe("overloaded_error mid-stream → auto-retry", () => {
  // Verbatim shape from a real run that paused with provider_error.
  const overloadedEnvelope =
    '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011..."}';

  test("recognises the overloaded_error envelope", () => {
    expect(isOverloadedErrorMessage(overloadedEnvelope)).toBe(true);
    expect(isOverloadedErrorMessage('{"type":"error","error":{"type":"invalid_request_error"}}')).toBe(false);
    expect(isOverloadedErrorMessage(undefined)).toBe(false);
    expect(isOverloadedErrorMessage("")).toBe(false);
  });

  test("normalises a captured 200 to the canonical 529", () => {
    expect(effectiveProviderHttpStatus(200, overloadedEnvelope)).toBe(ANTHROPIC_OVERLOADED_STATUS);
    // A non-overloaded envelope passes the captured status through.
    expect(effectiveProviderHttpStatus(200, '{"type":"error","error":{"type":"api_error"}}')).toBe(200);
    expect(effectiveProviderHttpStatus(400, "400 invalid")).toBe(400);
    expect(effectiveProviderHttpStatus(null, "stream aborted")).toBeNull();
  });

  test("an overloaded_error envelope with status 200 classifies as auto-retry", () => {
    const effective = effectiveProviderHttpStatus(200, overloadedEnvelope);
    const decision = decideProviderRetry({
      httpStatus: effective,
      priorAttempt: 0,
      now: 1_000_000,
      cumulativeDelayMs: 0,
    });
    expect(decision.kind).toBe("auto-retry");
  });
});
