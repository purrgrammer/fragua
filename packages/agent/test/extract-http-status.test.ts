// Provider-error HTTP-status extraction — see run 01ks30ky5rvpqhdkgp.
//
// pi-ai's stream surfaces an Anthropic 400 invalid_request_error as a
// `stopReason="error"` AssistantMessage whose `errorMessage` starts with
// the HTTP status as a bare number, followed by the JSON body:
//
//   "400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",...}}"
//
// The `onResponse` capture in PiLlmBackend never fires for this class
// (pi-ai rejects pre-stream), so `lastHttpStatus` stays `null` and the
// `pause_provider` outcome reaches the daemon with `httpStatus: null`.
// `isAutoRetryableStatus(null) === true`, so the run enters the
// auto-retry chain and burns the full 5-attempt budget against a
// deterministically-failing request before halting with
// `reason="provider_exhausted"` — instead of pausing immediately as
// `reason="provider_error"` for the operator to repair the payload.
//
// The fix path: PiLlmBackend extracts the HTTP status from the error
// message when the response-header capture missed it, so the
// `pause_provider` outcome carries `httpStatus: 400` and the
// provider-retry classifier falls through to its manual branch.

import { describe, expect, test } from "bun:test";
import { decideProviderRetry } from "../../daemon/src/provider-retry-policy.ts";
import { extractHttpStatusFromErrorMessage } from "../src/backend.ts";

describe("extractHttpStatusFromErrorMessage", () => {
  // Verbatim from run 01ks30ky5rvpqhdkgp, seq 1237 fact.run_paused payload.
  const anthropic400 =
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.52.content.1: unexpected `tool_use_id` found in `tool_result` blocks: toolu_012RWWkok9GB52PNfYuTVbDb. Each `tool_result` block must have a corresponding `tool_use` block in the previous message."},"request_id":"req_011..."}';

  test("extracts 400 from an Anthropic invalid_request_error prefix", () => {
    expect(extractHttpStatusFromErrorMessage(anthropic400)).toBe(400);
  });

  test("extracts 401 / 403 / 404 / 413 / 422 from a leading-status error string", () => {
    expect(extractHttpStatusFromErrorMessage('401 {"type":"error"}')).toBe(401);
    expect(extractHttpStatusFromErrorMessage('403 {"type":"error"}')).toBe(403);
    expect(extractHttpStatusFromErrorMessage('404 {"type":"error"}')).toBe(404);
    expect(extractHttpStatusFromErrorMessage('413 {"type":"error"}')).toBe(413);
    expect(extractHttpStatusFromErrorMessage('422 {"type":"error"}')).toBe(422);
  });

  test("returns null on a message with no leading HTTP status", () => {
    expect(extractHttpStatusFromErrorMessage("stream aborted")).toBeNull();
    expect(extractHttpStatusFromErrorMessage("")).toBeNull();
    expect(extractHttpStatusFromErrorMessage("provider returned no response")).toBeNull();
  });

  test("does not match bare 3-digit numbers that are not HTTP statuses", () => {
    // A status code is 1xx..5xx. 600+ or 0xx must not be extracted.
    expect(extractHttpStatusFromErrorMessage("999 weird")).toBeNull();
    expect(extractHttpStatusFromErrorMessage("042 some payload")).toBeNull();
  });
});

describe("end-to-end: extracted 400 → provider_error (manual)", () => {
  // The classifier is correct for an explicit 400 (manual). What the
  // run-time path was missing is the *extraction* of 400 from the error
  // message. This composition test asserts the two halves wire up: a
  // representative Anthropic 400 invalid_request_error, run through the
  // extractor and into `decideProviderRetry`, yields a manual decision
  // (which `result-to-facts.ts` translates to
  // `fact.run_paused{reason:"provider_error"}`).
  test("anthropic 400 invalid_request_error → manual decision", () => {
    const errorMessage =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.52.content.1: unexpected `tool_use_id` found in `tool_result` blocks."}}';
    const httpStatus = extractHttpStatusFromErrorMessage(errorMessage);
    expect(httpStatus).toBe(400);

    const decision = decideProviderRetry({
      httpStatus,
      priorAttempt: 0,
      now: 1_000_000,
      cumulativeDelayMs: 0,
    });
    expect(decision.kind).toBe("manual");
  });
});
