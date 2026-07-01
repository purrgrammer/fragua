// Regression: a goal-gate retarget must not leak the failing gate's abort
// into the retargeted node's outcome.
//
// Evaluator–optimizer shape: draft (generator) → evaluate (goal gate) that
// calls `abort` on REJECT to drive its §3.4 retarget back to draft. draft and
// evaluate share a `thread_id`, so when the retargeted draft re-runs its
// hydrated transcript contains the gate's earlier `abort` toolCall. A clean
// re-run of draft (text-only, no abort of its own) must resolve to
// `outcome=success` — the whole-transcript abort scan wrongly re-detected the
// gate's abort and stamped draft `fail`, which then terminated the run with a
// stale `aborted_exit` at retries 1 instead of iterating the loop.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@earendil-works/pi-ai";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@fragua/workspace";
import { PiLlmBackend } from "../src/backend.ts";

describe("PiLlmBackend — retargeted node after a gate abort on a shared thread", () => {
  test("a clean re-run whose hydrated transcript carries the gate's abort resolves to success", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-retarget-abort-"));
    const faux = registerFauxProvider();
    try {
      // draft's re-run produces plain text and no abort of its own.
      faux.setResponses([fauxAssistantMessage([fauxText("DRAFT_DONE")], { stopReason: "stop" })]);

      const model = faux.getModel();
      const registry = new ToolRegistry();
      registry.registerAll(CORE_TOOLS);
      const env = new LocalEnvironment({ cwd: scratch });
      const backend = new PiLlmBackend({
        registry,
        env,
        resolveModel: () => model,
        defaultModel: { provider: model.provider, model: model.id },
        skills: [],
      });

      // Shared-thread history seeded by the upstream gate: a prior draft, then
      // the evaluate gate REJECTing via `abort`. This is what the retargeted
      // draft rehydrates.
      const priorUser = { role: "user", content: "draft the thing", timestamp: 1 } as AgentMessage;
      const priorDraft = {
        role: "assistant",
        content: [{ type: "text", text: "first draft" }],
        stopReason: "stop",
        timestamp: 2,
      } as unknown as AgentMessage;
      const gateAbort = {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc_gate", name: "abort", arguments: { reason: "REJECT: needs work" } }],
        stopReason: "toolUse",
        timestamp: 3,
      } as unknown as AgentMessage;
      const gateAbortResult = {
        role: "toolResult",
        toolCallId: "tc_gate",
        toolName: "abort",
        content: [{ type: "text", text: "aborted" }],
        isError: false,
        timestamp: 4,
      } as unknown as AgentMessage;

      const outcome = await backend.run({
        node: { id: "draft", type: "llm", attrs: { thread_id: "t1" } },
        prompt: "revise the draft",
        thread_id: "t1",
        signal: new AbortController().signal,
        run_id: "test-retarget-abort",
        workflow_sha: "sha",
        priorMessages: [priorUser, priorDraft, gateAbort, gateAbortResult],
      });

      expect(outcome.status).toBe("success");
    } finally {
      faux.unregister();
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
