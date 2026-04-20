// Regression: the backend must refuse to silently run with an empty tool
// registry when the node requested tools via `allowed_tools`.
//
// Without this guard, an empty ToolRegistry (e.g. `new ToolRegistry()`
// without `registerAll(CORE_TOOLS)`) is passed through to pi-agent-core as
// `tools: []`. The model has no tool schemas to structure calls against
// and emits `<tool_call>` XML as plain text — the run looks successful
// (status=success, no errors) while every tool the agent "invoked" was
// hallucinated. See commit that introduced this guard for the full
// forensics from quick-change run 01kpp88qs110gb9wzh.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@mariozechner/pi-ai";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { PiCodergenBackend } from "../src/backend.ts";

describe("PiCodergenBackend — empty registry guard", () => {
  test("allowed_tools set + empty registry → fail with explicit reason", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-registry-"));
    try {
      const faux = registerFauxProvider();
      try {
        const model = faux.getModel();
        const registry = new ToolRegistry(); // deliberately EMPTY
        const env = new LocalEnvironment({ cwd: scratch });
        const backend = new PiCodergenBackend({
          registry,
          env,
          resolveModel: () => model,
          defaultModel: { provider: model.provider, model: model.id },
        });

        const outcome = await backend.run({
          node: {
            id: "implement",
            shape: "box",
            attrs: { allowed_tools: ["read", "write", "edit", "bash"] },
            classes: [],
          },
          prompt: "do work",
          context: {},
          thread_id: undefined,
          fidelity: "compact",
          signal: new AbortController().signal,
          run_id: "test-empty-registry",
          workflow_sha: "sha",
        });

        expect(outcome.status).toBe("fail");
        // The error mentions which tools were asked for and what's registered.
        expect(outcome.failure_reason).toContain("allowed_tools=[read, write, edit, bash]");
        expect(outcome.failure_reason).toContain("registered: []");
        // Nudge toward the fix.
        expect(outcome.failure_reason).toContain("registerAll(CORE_TOOLS)");
      } finally {
        faux.unregister();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("allowed_tools set + registry populated → guard doesn't trip", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-registry-ok-"));
    try {
      const faux = registerFauxProvider();
      try {
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

        // Faux default response is an empty stop — enough to exercise the
        // guard path without asserting model behaviour.
        const outcome = await backend.run({
          node: {
            id: "implement",
            shape: "box",
            attrs: { allowed_tools: ["read", "bash"] },
            classes: [],
          },
          prompt: "do work",
          context: {},
          thread_id: undefined,
          fidelity: "compact",
          signal: new AbortController().signal,
          run_id: "test-registry-ok",
          workflow_sha: "sha",
        });

        // Not failing on the guard — either success or a provider-level
        // outcome. The failure_reason MUST NOT mention the registry guard.
        if (outcome.status === "fail") {
          expect(outcome.failure_reason ?? "").not.toContain("allowed_tools=");
        }
      } finally {
        faux.unregister();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
