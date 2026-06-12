// Unclassified agent-loop error must fail OPEN to a resumable pause.
//
// Observed live: a provider SDK threw a generic error ("An unknown error
// occurred") with no HTTP status; the stream had already produced partial
// content, so the backend's stopReason="error" branch saw neither a
// 4xx/5xx status nor empty content and fell through to a plain `fail`
// outcome. With no fail-edge declared, the executor turned that into
// `fact.run_halted{reason:"aborted_exit"}` — a terminal, unresumable halt
// reserved for a deliberate `abort` tool call (findAbortToolCall).
//
// Contract: an error envelope that reaches the result mapping with no
// classification — no abort tool call in the transcript, no extractable
// HTTP status — must yield a `provider_error` outcome, which the
// handler-bridge maps to `pause_provider` and the daemon to
// `fact.run_paused{reason:"provider_error"}` with the error message as
// detail. Never a terminal halt.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@earendil-works/pi-ai";
import type { Outcome } from "@fragua/core";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@fragua/workspace";
import { PiLlmBackend } from "../src/backend.ts";

async function runBackendWith(responses: Parameters<ReturnType<typeof registerFauxProvider>["setResponses"]>[0]) {
  const scratch = await mkdtemp(join(tmpdir(), "fragua-unclassified-err-"));
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
      run_id: "test-unclassified-error",
      workflow_sha: "sha",
    });
    return outcome;
  } finally {
    faux.unregister();
    await rm(scratch, { recursive: true, force: true });
  }
}

describe("unclassified agent-loop error fails open to a resumable pause", () => {
  test("generic SDK error after partial content (no HTTP status, no abort tool call) → provider_error, not a halt-bound plain fail", async () => {
    // The live shape: a provider streamed some content, then errored with a
    // generic message that carries no leading HTTP status. `errorMessage`
    // mirrors pi-ai's bedrock/vertex fallback `Error("An unknown error
    // occurred")`.
    const outcome = await runBackendWith([
      fauxAssistantMessage([fauxText("partial answer before the transport died")], {
        stopReason: "error",
        errorMessage: "An unknown error occurred",
      }),
    ]);

    expect(outcome.status).toBe("fail");
    // Fail OPEN: the unclassified error must carry the provider_error
    // envelope so the handler-bridge emits `pause_provider` →
    // fact.run_paused{reason:"provider_error"}. Without it the executor
    // halts terminally with reason="aborted_exit".
    expect(outcome.provider_error).toBeDefined();
    expect(outcome.provider_error?.errorMessage).toContain("An unknown error occurred");
    // The stream opened (HTTP 200) before dying, so the captured status is
    // 200 — or null when the failure never reached a response. Either way it
    // must not be misread as a deliberate-abort terminal halt; what matters
    // is that no 4xx/5xx classification was available.
    expect([null, 200]).toContain(outcome.provider_error?.httpStatus);
    expect(outcome.halt_reason).toBeUndefined();
  }, 15_000);

  test("plain thrown Error from the stream with non-empty failure envelope (pi-agent-core handleRunFailure shape) → provider_error", async () => {
    // pi-agent-core's handleRunFailure synthesises
    // `content: [{type:"text", text:""}]` — length 1, so the backend's
    // `noContent` guard does not catch it. Model that envelope directly.
    const outcome = await runBackendWith([
      fauxAssistantMessage([fauxText("")], {
        stopReason: "error",
        errorMessage: "socket hang up",
      }),
    ]);

    expect(outcome.status).toBe("fail");
    expect(outcome.provider_error).toBeDefined();
    expect(outcome.provider_error?.errorMessage).toContain("socket hang up");
    expect(outcome.halt_reason).toBeUndefined();
  }, 15_000);
});
