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
  PiLlmBackend,
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
});
