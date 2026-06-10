// A clean (non-aborted) run must leave NO listeners behind on input.signal.
// Two once-listeners are registered per run (`abortListener` wiring
// signal → agent.abort, and the teardown-grace `arm`); on a clean run
// neither fires, so both must be explicitly removed in the finally — a
// leftover listener pins the whole run scope (agent state, transcript) to
// the signal's lifetime, which on a deadline-armed signal outlives the
// dispatch by the full timeout, and on the daemon's shutdown signal
// outlives it forever (N branches × K supersteps of retained heap).

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@earendil-works/pi-ai";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@fragua/workspace";
import { PiLlmBackend } from "../src/backend.ts";

describe("PiLlmBackend — signal listener release", () => {
  test("a clean run removes every listener it added to input.signal", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-release-"));
    try {
      const faux = registerFauxProvider();
      try {
        faux.setResponses([fauxAssistantMessage([fauxText("done")], { stopReason: "stop" })]);
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

        // Count add/remove pairs on the signal. `{once: true}` listeners only
        // self-remove when they FIRE — the signal never aborts here, so every
        // add must be matched by an explicit remove.
        const controller = new AbortController();
        const signal = controller.signal;
        let outstanding = 0;
        const origAdd = signal.addEventListener.bind(signal);
        const origRemove = signal.removeEventListener.bind(signal);
        signal.addEventListener = ((type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
          outstanding++;
          return origAdd(type, fn, opts);
        }) as typeof signal.addEventListener;
        signal.removeEventListener = ((type: string, fn: EventListener) => {
          outstanding--;
          return origRemove(type, fn);
        }) as typeof signal.removeEventListener;

        const outcome = await backend.run({
          node: { id: "n", type: "llm", attrs: {} },
          prompt: "do work",
          thread_id: undefined,
          signal,
          run_id: "test-release",
          workflow_sha: "sha",
        });
        expect(outcome.status).toBe("success");
        expect(outstanding).toBe(0);
      } finally {
        faux.unregister();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
