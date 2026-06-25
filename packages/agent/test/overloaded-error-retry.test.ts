// Anthropic `overloaded_error` mid-stream misclassification.
//
// Anthropic's overload can arrive mid-stream: the HTTP response already
// returned 200 (so `onResponse` captures `lastHttpStatus = 200`), and the
// overload then surfaces as an `error` event in the stream body whose
// envelope is `{"type":"error","error":{"type":"overloaded_error",...}}`.
//
// An `overloaded_error` is transient and auto-retryable — it should pause
// as `provider_retry` (paused_auto) and wake on the backoff timer, exactly
// like a 529. The backend's job is to normalise the effective status to the
// canonical 529; the daemon's status-only classifier then auto-retries it.
//
// The daemon half (529 → auto-retry) is covered in-package by
// `packages/daemon/test/provider-retry-policy.test.ts` (`isAutoRetryableStatus`
// pins `[529, true]`) — no cross-package reach here.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@earendil-works/pi-ai";
import type { Outcome } from "@fragua/core";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@fragua/workspace";
import {
  ANTHROPIC_OVERLOADED_STATUS,
  effectiveProviderHttpStatus,
  isOverloadedErrorMessage,
  isTransientTransportErrorMessage,
  PiLlmBackend,
  TRANSIENT_TRANSPORT_STATUS,
} from "../src/backend.ts";

// Verbatim shape from a real run that paused with provider_error.
const OVERLOADED_ENVELOPE =
  '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011..."}';

describe("isOverloadedErrorMessage / effectiveProviderHttpStatus — the AGENT half (envelope → 529)", () => {
  test("recognises the overloaded_error envelope (incl. a leading HTTP-status prefix)", () => {
    expect(isOverloadedErrorMessage(OVERLOADED_ENVELOPE)).toBe(true);
    // The extractHttpStatusFromErrorMessage shape: status prefix + envelope.
    expect(isOverloadedErrorMessage(`529 ${OVERLOADED_ENVELOPE}`)).toBe(true);
    expect(isOverloadedErrorMessage('{"type":"error","error":{"type":"invalid_request_error"}}')).toBe(false);
    expect(isOverloadedErrorMessage(undefined)).toBe(false);
    expect(isOverloadedErrorMessage("")).toBe(false);
  });

  test("anchors on envelope structure — a coincidental substring does NOT match", () => {
    // A manual-class error whose body merely embeds the literal (an echoed
    // prior error / log). Must stay false, else it burns the retry budget.
    const echoed =
      '{"type":"error","error":{"type":"invalid_request_error","message":"prior failure was \\"type\\":\\"overloaded_error\\""}}';
    expect(isOverloadedErrorMessage(echoed)).toBe(false);
    // Non-JSON body that happens to contain the substring.
    expect(isOverloadedErrorMessage('log: "type":"overloaded_error" seen earlier')).toBe(false);
  });

  test("normalises a captured 200 to the canonical 529", () => {
    expect(effectiveProviderHttpStatus(200, OVERLOADED_ENVELOPE)).toBe(ANTHROPIC_OVERLOADED_STATUS);
    // A non-overloaded envelope passes the captured status through.
    expect(effectiveProviderHttpStatus(200, '{"type":"error","error":{"type":"api_error"}}')).toBe(200);
    expect(effectiveProviderHttpStatus(400, "400 invalid")).toBe(400);
    expect(effectiveProviderHttpStatus(null, "stream aborted")).toBeNull();
  });

  test("normalises a mid-stream transient transport error (captured 200) to 408", () => {
    // A request/operation timeout arriving mid-stream carries a captured 200
    // (the response started, then the connection timed out). It is transient
    // and auto-retryable — normalise to 408 so the status-only classifier
    // routes it to provider_retry instead of a manual provider_error pause.
    expect(effectiveProviderHttpStatus(200, "The operation timed out.")).toBe(TRANSIENT_TRANSPORT_STATUS);
    // A genuinely unknown error stays manual (fail-open to a resumable pause).
    expect(effectiveProviderHttpStatus(200, "An unknown error occurred")).toBe(200);
    // An already-auto-retryable captured status is left as-is, not
    // downgraded to 408: a 503 with a coincidental "timeout" stays 503.
    expect(effectiveProviderHttpStatus(503, "503 gateway timeout")).toBe(503);
    expect(effectiveProviderHttpStatus(null, "socket hang up")).toBeNull();
    // overloaded_error precedence is unaffected by the transient path.
    expect(effectiveProviderHttpStatus(200, OVERLOADED_ENVELOPE)).toBe(ANTHROPIC_OVERLOADED_STATUS);
    // A manual 4xx with a transient-looking word is NOT flipped to 408.
    expect(effectiveProviderHttpStatus(400, "400 invalid timeout config")).toBe(400);
    // A non-auto-retryable 5xx (505–528, 530–599) with a transient-looking
    // word is NOT flipped to 408 — it stays manual, matching the daemon's
    // classification. Only 500–504 / 529 are auto-retryable 5xx codes.
    expect(effectiveProviderHttpStatus(507, "507 connection reset mid-body")).toBe(507);
    expect(effectiveProviderHttpStatus(511, "511 network error")).toBe(511);
    expect(effectiveProviderHttpStatus(530, "530 socket hang up")).toBe(530);
  });
});

describe("isTransientTransportErrorMessage — the conservative transient set", () => {
  test("recognises each listed transient signature (case-insensitive)", () => {
    for (const msg of [
      "The operation timed out.",
      "Request timed out",
      "connect ETIMEDOUT 1.2.3.4:443",
      "socket hang up",
      "read ECONNRESET",
      "write EPIPE",
      "network error",
      "Connection error.",
      "connection reset by peer",
    ]) {
      expect(isTransientTransportErrorMessage(msg)).toBe(true);
    }
  });

  test("rejects unknown / unrelated messages and empties", () => {
    expect(isTransientTransportErrorMessage("An unknown error occurred")).toBe(false);
    expect(isTransientTransportErrorMessage("invalid_request_error: bad model")).toBe(false);
    expect(isTransientTransportErrorMessage("401 unauthorized")).toBe(false);
    // Permanent failures whose body coincidentally embeds a transient word
    // must NOT match — they'd otherwise burn the 5-attempt retry budget.
    expect(isTransientTransportErrorMessage("invalid network configuration")).toBe(false);
    expect(isTransientTransportErrorMessage("network access blocked")).toBe(false);
    expect(isTransientTransportErrorMessage("TLS handshake timeout")).toBe(false);
    expect(isTransientTransportErrorMessage("connect ECONNREFUSED 127.0.0.1:443")).toBe(false);
    expect(isTransientTransportErrorMessage(undefined)).toBe(false);
    expect(isTransientTransportErrorMessage(null)).toBe(false);
    expect(isTransientTransportErrorMessage("")).toBe(false);
  });
});

async function runBackendWith(responses: Parameters<ReturnType<typeof registerFauxProvider>["setResponses"]>[0]) {
  const scratch = await mkdtemp(join(tmpdir(), "fragua-overloaded-err-"));
  const faux = registerFauxProvider();
  try {
    faux.setResponses(responses);
    const model = faux.getModel();
    const registry = new ToolRegistry();
    registry.registerAll(CORE_TOOLS);
    const env = new LocalEnvironment({ cwd: scratch });
    const backend = new PiLlmBackend({
      registry,
      env,
      resolveModel: () => model,
      defaultModel: { provider: model.provider, model: model.id },
    });
    const outcome: Outcome = await backend.run({
      node: { id: "n1", type: "llm", attrs: {} },
      prompt: "do the thing",
      thread_id: undefined,
      signal: new AbortController().signal,
      run_id: "test-overloaded-error",
      workflow_sha: "sha",
    });
    return outcome;
  } finally {
    faux.unregister();
    await rm(scratch, { recursive: true, force: true });
  }
}

describe("overloaded_error end-to-end through PiLlmBackend — the seam", () => {
  test("a mid-stream overloaded_error (partial content, captured status 200) → provider_error carrying 529, which the daemon auto-retries", async () => {
    // The live shape: the stream produced partial content (so the backend's
    // `noContent` guard is NOT what classifies it — the normalised 529 must
    // drive the `httpIs4xx5xx` branch), then errored with the overloaded
    // envelope. `onResponse` captured 200.
    const outcome = await runBackendWith([
      fauxAssistantMessage([fauxText("partial answer before the overload")], {
        stopReason: "error",
        errorMessage: OVERLOADED_ENVELOPE,
      }),
    ]);

    expect(outcome.status).toBe("fail");
    expect(outcome.provider_error).toBeDefined();
    // The crux: the overload normalises to 529, NOT the captured 200. The
    // daemon's status-only classifier (provider-retry-policy.test.ts) then
    // routes 529 to provider_retry / paused_auto instead of a manual pause.
    expect(outcome.provider_error?.httpStatus).toBe(ANTHROPIC_OVERLOADED_STATUS);
    expect(outcome.halt_reason).toBeUndefined();
  }, 15_000);

  test("a mid-stream transient transport timeout (partial content, captured status 200) → provider_error carrying the auto-retryable 408", async () => {
    // The live shape from the fleet: the stream produced partial content,
    // then errored with `Error("The operation timed out.")`; `onResponse`
    // captured 200. The transient signature normalises the effective status
    // to 408 so the daemon's status-only classifier (which already covers
    // 408 in provider-retry-policy.test.ts) routes it to provider_retry /
    // paused_auto instead of a manual pause.
    const outcome = await runBackendWith([
      fauxAssistantMessage([fauxText("partial answer before the transport died")], {
        stopReason: "error",
        errorMessage: "The operation timed out.",
      }),
    ]);

    expect(outcome.status).toBe("fail");
    expect(outcome.provider_error).toBeDefined();
    expect(outcome.provider_error?.httpStatus).toBe(TRANSIENT_TRANSPORT_STATUS);
    expect(outcome.halt_reason).toBeUndefined();
  }, 15_000);
});
