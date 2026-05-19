// Regression: pi-agent-core synthesises an assistant message with
// `content: []` + `stopReason: "error" | "aborted"` for a provider
// transport failure or in-flight abort (see `handleRunFailure` in
// pi-agent-core/dist/agent.js). The backend used to forward that
// envelope to `persistMessage`, bloating the `messages` table with
// N duplicates on every provider-error retry chain and making the
// conversation view look like the LLM was talking to itself.
//
// Two-shape probe:
//   1. `stopReason: "error"`, `errorMessage` set    → MUST NOT persist
//   2. `stopReason: "aborted"`, content empty       → MUST NOT persist
//
// The corresponding `cost.recorded` event still fires (with zeros);
// cost accounting is unaffected.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { registerFauxProvider } from "@mariozechner/pi-ai";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { PiCodergenBackend } from "../src/backend.ts";

describe("PiCodergenBackend — empty-content failure envelopes are not persisted", () => {
  test("provider transport error (stopReason=error, content=[]) does not reach persistMessage; cost.recorded still fires", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-persist-fail-"));
    const faux = registerFauxProvider();
    try {
      // streamFn that throws — pi-agent-core's runWithLifecycle catches,
      // handleRunFailure synthesises the empty-content error envelope.
      const failingStream = (): Promise<never> => {
        const err = new Error("Provider overloaded") as Error & { httpStatus?: number };
        err.httpStatus = 200;
        return Promise.reject(err);
      };
      faux.setResponses([failingStream]);

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

      const persisted: AgentMessage[] = [];
      let costRecordedCount = 0;
      await backend.run({
        node: { id: "n", shape: "box", attrs: {}, classes: [] },
        prompt: "do work",
        thread_id: undefined,
        signal: new AbortController().signal,
        run_id: "test-fail-persist",
        workflow_sha: "sha",
        emit: async (type) => {
          if (type === "cost.recorded") costRecordedCount += 1;
        },
        persistMessage: (m) => {
          persisted.push(m);
        },
      });

      // The empty failure envelope MUST NOT land in persisted[].
      const assistantRows = persisted.filter((m) => m.role === "assistant");
      const emptyErrorRows = assistantRows.filter(
        (m) =>
          Array.isArray(m.content) &&
          m.content.length === 0 &&
          ((m as { stopReason?: string }).stopReason === "error" ||
            (m as { stopReason?: string }).stopReason === "aborted"),
      );
      expect(emptyErrorRows).toEqual([]);

      // cost.recorded still fires — cost accounting unaffected.
      expect(costRecordedCount).toBeGreaterThanOrEqual(1);
    } finally {
      faux.unregister();
      await rm(scratch, { recursive: true, force: true });
    }
  }, 15_000);

  test("aborted run (stopReason=aborted, content=[]) does not reach persistMessage either", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-persist-abort-"));
    const faux = registerFauxProvider();
    try {
      // Hang until signal aborts; pi-agent-core then synthesises the
      // empty-content aborted envelope.
      const hangThenAbort = (_ctx: unknown, opts: { signal?: AbortSignal } | undefined): Promise<never> =>
        new Promise((_, reject) => {
          const sig = opts?.signal;
          if (!sig) return reject(new Error("no signal"));
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
      setTimeout(() => controller.abort(), 50);

      const persisted: AgentMessage[] = [];
      try {
        await backend.run({
          node: { id: "n", shape: "box", attrs: {}, classes: [] },
          prompt: "do work",
          thread_id: undefined,
          signal: controller.signal,
          run_id: "test-abort-persist",
          workflow_sha: "sha",
          persistMessage: (m) => {
            persisted.push(m);
          },
        });
      } catch {
        // backend.run throws AbortError on signal abort — expected.
      }

      const assistantRows = persisted.filter((m) => m.role === "assistant");
      const emptyAbortRows = assistantRows.filter(
        (m) =>
          Array.isArray(m.content) && m.content.length === 0 && (m as { stopReason?: string }).stopReason === "aborted",
      );
      expect(emptyAbortRows).toEqual([]);
    } finally {
      faux.unregister();
      await rm(scratch, { recursive: true, force: true });
    }
  }, 15_000);
});
