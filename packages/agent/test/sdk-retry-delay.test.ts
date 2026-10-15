// pi-ai refuses a server-requested Retry-After above its 60s cap and surfaces
// the failure as `Server requested <N>s retry delay (max: 60s). <provider msg>`.
// The backend must recover the delay + status from that text so the daemon can
// own the long wait instead of pausing for an operator.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { Outcome } from "@fragua/core";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@fragua/workspace";
import { isRateLimitErrorMessage, PiLlmBackend, parseSdkRetryDelay } from "../src/backend.ts";
import { classifyTerminalMessage } from "../src/provider-errors.ts";

const FIDELITY_MESSAGE =
  'Server requested 12311s retry delay (max: 60s). 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011"}';

const OVERLOADED_WITH_DELAY =
  'Server requested 300s retry delay (max: 60s). 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

describe("parseSdkRetryDelay", () => {
  test("parseSdkRetryDelay — the fidelity 429 message → 429 + 12311000 ms", () => {
    expect(parseSdkRetryDelay(FIDELITY_MESSAGE)).toEqual({ httpStatus: 429, retryAfterMs: 12_311_000 });
  });

  test("parseSdkRetryDelay — 529 overloaded_error with a delay → 529 + delay", () => {
    expect(parseSdkRetryDelay(OVERLOADED_WITH_DELAY)).toEqual({ httpStatus: 529, retryAfterMs: 300_000 });
    const noStatusPrefix =
      'Server requested 120s retry delay (max: 60s). {"type":"error","error":{"type":"overloaded_error"}}';
    expect(parseSdkRetryDelay(noStatusPrefix)).toEqual({ httpStatus: 529, retryAfterMs: 120_000 });
  });

  test("parseSdkRetryDelay — prefix without trailing status defaults to 429; unrelated messages → null", () => {
    expect(parseSdkRetryDelay("Server requested 90s retry delay (max: 60s)")).toEqual({
      httpStatus: 429,
      retryAfterMs: 90_000,
    });
    expect(parseSdkRetryDelay("429 rate limited")).toBeNull();
    expect(parseSdkRetryDelay("An unknown error occurred")).toBeNull();
    expect(parseSdkRetryDelay("note: Server requested 90s retry delay (max: 60s)")).toBeNull();
    expect(parseSdkRetryDelay(undefined)).toBeNull();
    expect(parseSdkRetryDelay(null)).toBeNull();
  });

  test("isRateLimitErrorMessage anchors on the envelope structure", () => {
    expect(isRateLimitErrorMessage('429 {"type":"error","error":{"type":"rate_limit_error"}}')).toBe(true);
    expect(isRateLimitErrorMessage('{"type":"error","error":{"type":"overloaded_error"}}')).toBe(false);
    expect(isRateLimitErrorMessage('log: "type":"rate_limit_error"')).toBe(false);
    expect(isRateLimitErrorMessage(undefined)).toBe(false);
  });
});

describe("classifyTerminalMessage — SDK retry-delay rejection", () => {
  test("classifyTerminalMessage — parsed delay overrides a stale captured 200", () => {
    const last = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: FIDELITY_MESSAGE,
      timestamp: 0,
    } as unknown as AgentMessage;
    const outcome = classifyTerminalMessage({
      messages: [last],
      provider: "anthropic",
      lastHttpStatus: 200,
      lastRetryAfterMs: undefined,
      hydratedCount: 0,
      signalAborted: false,
    });
    expect(outcome).not.toBeNull();
    expect(outcome?.provider_error?.httpStatus).toBe(429);
    expect(outcome?.provider_error?.retryAfterMs).toBe(12_311_000);
  });
});

describe("SDK retry-delay rejection end-to-end through PiLlmBackend", () => {
  test("end-to-end through PiLlmBackend (faux provider) — rate-limit delay message → provider_error 429 + retryAfterMs", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-sdk-retry-delay-"));
    const faux = registerFauxProvider();
    try {
      faux.setResponses([
        fauxAssistantMessage([fauxText("partial answer before the rate limit")], {
          stopReason: "error",
          errorMessage: FIDELITY_MESSAGE,
        }),
      ]);
      const model = faux.getModel();
      const registry = new ToolRegistry();
      registry.registerAll(CORE_TOOLS);
      const backend = new PiLlmBackend({
        registry,
        env: new LocalEnvironment({ cwd: scratch }),
        resolveModel: () => model,
        defaultModel: { provider: model.provider, model: model.id },
      });
      const outcome: Outcome = await backend.run({
        node: { id: "n1", type: "llm", attrs: {} },
        prompt: "do the thing",
        thread_id: undefined,
        signal: new AbortController().signal,
        run_id: "test-sdk-retry-delay",
        workflow_sha: "sha",
      });
      expect(outcome.status).toBe("fail");
      expect(outcome.provider_error?.httpStatus).toBe(429);
      expect(outcome.provider_error?.retryAfterMs).toBe(12_311_000);
      expect(outcome.halt_reason).toBeUndefined();
    } finally {
      faux.unregister();
      await rm(scratch, { recursive: true, force: true });
    }
  }, 15_000);
});
