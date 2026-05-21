// Repro for run 01kqwzpt0hyfws0a0j: provider HTTP fetch wedged at the
// network layer. The Agent's internal AbortController forwards
// `options.signal` to streamSimple, but if the provider's fetch handle
// never honors that signal (slow / hung TCP, SDK that lost the wiring,
// etc.), `agent.prompt()` never returns. The wrapper at
// packages/agent/src/backend.ts wires `input.signal` → `agent.abort()`
// but does NOT race the awaited prompt against `input.signal`, so a
// stuck provider fetch leaks the handler past the executor's
// `maxMs + LEAK_GRACE_MS` budget — surfacing as
// `fact.handler_timeout_leaked` + `fact.run_halted{reason:"error",
// detail:"handler_leaked"}`.
//
// This test simulates the wedged-socket path with a faux provider that
// IGNORES options.signal and never resolves. Today the test fails:
// `backend.run()` hangs past the assertion bound. The fix wires
// `input.signal` to a teardown that abandons the awaited prompt
// (forwarding fetch-level AbortController, or racing the prompt against
// the input signal) so the handler returns inside the grace window.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@fragua/workspace";
import { registerFauxProvider } from "@mariozechner/pi-ai";
import { PiLlmBackend } from "../src/backend.ts";

describe("PiLlmBackend — cancel signal (fetch wedged)", () => {
  test("aborting input.signal tears down a provider fetch that ignores signal", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-cancel-stuck-"));
    try {
      const faux = registerFauxProvider();
      try {
        // Network-wedged fetch: the Promise never resolves AND never
        // listens for `options.signal`. This is the bad-citizen provider
        // SDK case the bug report describes — agent.abort() flips the
        // Agent's own controller, but the awaited stream promise inside
        // pi-agent-core's loop has no exit door.
        const wedgedFetch = (): Promise<never> => new Promise<never>(() => {});
        faux.setResponses([wedgedFetch]);

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

        const controller = new AbortController();
        // Mirrors the executor: control.cancel arrives, the
        // per-dispatch AbortController flips, the handler is expected
        // to unwind inside the leak grace window (10s) plus its own
        // teardown — call it 5s for headroom in this unit test.
        setTimeout(() => controller.abort(), 50);

        const started = Date.now();
        let elapsed = -1;
        let thrown: unknown;
        try {
          await backend.run({
            node: { id: "n", type: "llm", attrs: {} },
            prompt: "do work",
            thread_id: undefined,
            signal: controller.signal,
            run_id: "test-cancel-stuck",
            workflow_sha: "sha",
          });
        } catch (err) {
          thrown = err;
        }
        elapsed = Date.now() - started;

        // Hard ceiling: the executor gives the handler `maxMs +
        // LEAK_GRACE_MS` (10s) to drain after a timeout. To stay
        // inside that budget the wrapper MUST tear down a stuck
        // fetch within a few seconds of input.signal aborting. 5s is
        // generous; today the call hangs indefinitely.
        expect(elapsed).toBeLessThan(5000);
        // The wrapper signals the executor's `wasAborted` path by
        // throwing AbortError so the dispatch lands as
        // `fact.node_aborted`, not `fact.handler_timeout_leaked` /
        // `fact.run_halted{reason:error,detail:handler_leaked}`.
        expect(thrown).toBeDefined();
        expect((thrown as Error).name).toBe("AbortError");
      } finally {
        faux.unregister();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 15_000);
});
