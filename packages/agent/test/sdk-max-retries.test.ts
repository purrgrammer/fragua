// When backend.ts wires a custom streamFn on the Agent that injects
// `maxRetries: PROVIDER_SDK_MAX_RETRIES`, the faux provider's response
// factory receives those options on every call. This test captures the
// options the faux factory sees and asserts that `maxRetries` is set to
// the expected constant (8), proving the wrapper does not silently drop
// the field or use the SDK default of 2.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@fragua/workspace";
import type { StreamOptions } from "@mariozechner/pi-ai";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@mariozechner/pi-ai";
import { PiLlmBackend } from "../src/backend.ts";

describe("PiLlmBackend — Anthropic SDK maxRetries forwarding", () => {
  test("streamFn injects PROVIDER_SDK_MAX_RETRIES (8) into every stream call", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-sdk-retries-"));
    try {
      const faux = registerFauxProvider();
      try {
        let capturedMaxRetries: number | undefined;

        // The faux provider calls this factory for each LLM turn.
        // `options` here is the full StreamOptions object that the
        // backend's streamFn wrapper passes through — including
        // whatever `maxRetries` the wrapper injects.
        faux.setResponses([
          (_ctx: unknown, options: StreamOptions | undefined) => {
            capturedMaxRetries = options?.maxRetries;
            return fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });
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
        });

        await backend.run({
          node: { id: "n1", type: "llm", attrs: {} },
          prompt: "hello",
          thread_id: undefined,
          signal: new AbortController().signal,
          run_id: "test-sdk-retries",
          workflow_sha: "sha",
        });

        // PROVIDER_SDK_MAX_RETRIES = 8 in backend.ts. Without the fix,
        // no streamFn wrapper is wired and maxRetries stays undefined
        // (the SDK then uses its own default of 2).
        expect(capturedMaxRetries).toBe(8);
      } finally {
        faux.unregister();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
