// Probe for graceful-resume Option A precondition:
// when sanitiseUnpairedToolCalls re-pairs a tool call on rehydrate,
// the resulting hydrate transcript ends with
// [user, assistant{toolCall}, toolResult]. The proposed silent-
// rollback path produces this same shape by stripping cancelled
// toolResults at pause-commit time and letting the sanitiser
// re-pair them on the next dispatch.
//
// Before shipping the rollback we need to know: does pi-agent's
// runAgentLoop happily continue from a paired
// [assistant{toolCall}, toolResult] tail by streaming the next
// assistant message, or does it re-emit / re-execute the prior
// assistant turn (which would burn a fresh LLM call for work
// already done)?
//
// If this probe passes, Option A is safe to implement: pi-agent
// treats the paired tail as completed history and proceeds to
// the next turn.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@fragua/workspace";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@mariozechner/pi-ai";
import { PiLlmBackend } from "../src/backend.ts";

describe("PiLlmBackend — rehydrate with paired toolCall+toolResult tail", () => {
  test("paired [assistant{toolCall}, toolResult] hydrate tail: pi-agent streams the next turn, doesn't re-emit the prior", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-rehydrate-"));
    const faux = registerFauxProvider();
    try {
      // Observe every LLM call. The faux factory captures the
      // context.messages it was handed so we can inspect what
      // pi-agent passed in.
      let callCount = 0;
      let observedMessages: unknown[] = [];
      faux.setResponses([
        (ctx) => {
          callCount += 1;
          observedMessages = ctx.messages;
          return fauxAssistantMessage([fauxText("continuing after toolResult")], { stopReason: "stop" });
        },
      ]);

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

      // Construct the paired tail by hand. Shape mirrors what
      // sanitiseUnpairedToolCalls produces when a tool call is
      // re-paired on rehydrate — assistant with toolCall +
      // user-role toolResult with isError:false.
      const priorUser = { role: "user", content: "kick off work", timestamp: 1 } as AgentMessage;
      const priorAssistant = {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc_resumed", name: "bash", arguments: { command: "echo work" } }],
        stopReason: "toolUse",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        provider: model.provider,
        model: model.id,
        api: model.api,
        timestamp: 2,
      } as unknown as AgentMessage;
      const priorToolResult = {
        role: "toolResult",
        toolCallId: "tc_resumed",
        toolName: "bash",
        content: [{ type: "text", text: "(tool completed via crash-resilience hydration)" }],
        isError: false,
        timestamp: 3,
      } as unknown as AgentMessage;

      const outcome = await backend.run({
        node: {
          id: "n_parent",
          type: "llm",
          attrs: { allowed_tools: ["bash", "read"], thread_id: "t1" },
        },
        prompt: "what comes next?",
        thread_id: "t1",
        signal: new AbortController().signal,
        run_id: "test-rehydrate",
        workflow_sha: "sha",
        priorMessages: [priorUser, priorAssistant, priorToolResult],
      });

      // Headline: exactly one LLM call, and the request carried the
      // prior conversation verbatim (assistant with toolCall + the
      // paired toolResult), then the fresh user prompt.
      expect(callCount).toBe(1);
      expect(outcome.status).toBe("success");

      // Inspect what pi-agent forwarded to the LLM. We expect the
      // request to include the prior user/assistant/toolResult
      // turns plus the new user prompt — no duplication of the
      // prior assistant turn, no re-execution of the tool.
      const roles = observedMessages.map((m) => (m as { role: string }).role);
      // Roles after rehydrate + new user prompt:
      //   [user(prior), assistant(prior toolCall), toolResult, user(new)]
      // pi-ai's anthropic adapter folds toolResult into the
      // preceding user; our probe just confirms the prior tool
      // turn isn't repeated.
      const assistantCount = roles.filter((r) => r === "assistant").length;
      expect(assistantCount).toBe(1);
      // The new user prompt must be present.
      const userMessages = observedMessages.filter((m) => (m as { role: string }).role === "user");
      expect(userMessages.length).toBeGreaterThanOrEqual(1);
    } finally {
      faux.unregister();
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
