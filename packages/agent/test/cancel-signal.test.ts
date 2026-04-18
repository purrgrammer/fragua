// Signal-abort propagation: when the executor's AbortController trips
// (control.cancel arriving on control.jsonl), the backend MUST call
// agent.abort() so the in-flight LLM stream / tool loop unwinds. Without
// this wire-up the executor accepts the cancel but the Agent keeps
// streaming to completion — the bug that left runs executing for minutes
// after the user hit "Cancel" in the web UI.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, StreamOptions } from "@mariozechner/pi-ai";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@mariozechner/pi-ai";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { PiCodergenBackend } from "../src/backend.ts";

describe("PiCodergenBackend — cancel signal", () => {
  test("aborting input.signal mid-run stops the agent", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-cancel-"));
    try {
      const faux = registerFauxProvider();
      try {
        // Factory that blocks forever unless the stream signal aborts.
        // The fix wires input.signal → agent.abort(), which the Agent
        // forwards to the stream's AbortController.
        const hangThenAbort = (
          _ctx: unknown,
          options: StreamOptions | undefined,
        ): Promise<AssistantMessage> =>
          new Promise((resolve, reject) => {
            const sig = options?.signal;
            if (!sig) {
              resolve(fauxAssistantMessage([fauxText("no signal")], { stopReason: "stop" }));
              return;
            }
            const onAbort = (): void => reject(new DOMException("aborted", "AbortError"));
            if (sig.aborted) onAbort();
            else sig.addEventListener("abort", onAbort, { once: true });
          });
        faux.setResponses([hangThenAbort]);

        const model = faux.getModel();
        const registry = new ToolRegistry();
        registry.registerAll(CORE_TOOLS);
        const env = new LocalEnvironment({ cwd: scratch });
        const backend = new PiCodergenBackend({
          registry,
          env,
          resolveModel: () => model,
          defaultModel: { provider: model.provider, model: model.id },
        });

        const controller = new AbortController();
        // Abort shortly after run starts.
        setTimeout(() => controller.abort(), 50);

        const started = Date.now();
        const outcome = await backend.run({
          node: { id: "n", shape: "box", attrs: {}, edges: [] },
          prompt: "do work",
          context: {},
          thread_id: undefined,
          fidelity: "compact",
          signal: controller.signal,
          run_id: "test-cancel",
          workflow_sha: "sha",
        });
        const elapsed = Date.now() - started;

        // Must return quickly after the abort — well under 2s. Without
        // the wire-up this hangs forever on the blocking faux response.
        expect(elapsed).toBeLessThan(2000);
        // The run ends as a fail with stopReason=aborted (surfaced as
        // "agent stopped: aborted" by summarizeMessage fallback).
        expect(outcome.status).toBe("fail");
      } finally {
        faux.unregister();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
