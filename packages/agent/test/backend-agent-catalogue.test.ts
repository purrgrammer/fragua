// Backend integration: agents catalogue is rendered into the system
// prompt only when the node's tool pool actually includes `agent` and
// at least one profile is discovered.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context, StreamOptions } from "@mariozechner/pi-ai";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@mariozechner/pi-ai";
import type { AgentDefinition } from "@swarm/types";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { PiLlmBackend } from "../src/backend.ts";

function mkDef(name: string, description: string, projectCwd: string): AgentDefinition {
  return {
    name,
    description,
    body: `body for ${name}`,
    location: `${projectCwd}/.agents/agents/${name}.md`,
    sha256: "0".repeat(64),
    bytes: 1,
    scope: "project",
    source_dir: `${projectCwd}/.agents/agents`,
    project_cwd: projectCwd,
  };
}

describe("PiLlmBackend — agent catalogue injection", () => {
  test("agent tool present + agentDefinitions non-empty → catalogue rendered into systemPrompt", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-agent-cat-"));
    try {
      const faux = registerFauxProvider();
      try {
        const captured: string[] = [];
        const respond = (ctx: Context, _opts: StreamOptions | undefined): Promise<AssistantMessage> => {
          captured.push(ctx.systemPrompt ?? "");
          return Promise.resolve(fauxAssistantMessage([fauxText("done")], { stopReason: "stop" }));
        };
        faux.setResponses([respond]);

        const model = faux.getModel();
        const registry = new ToolRegistry();
        registry.registerAll(CORE_TOOLS);
        const env = new LocalEnvironment({ cwd: scratch });
        const backend = new PiLlmBackend({
          registry,
          env,
          resolveModel: () => model,
          defaultModel: { provider: model.provider, model: model.id },
          agentDefinitions: [mkDef("reviewer", "Reviews diffs.", scratch), mkDef("researcher", "Reads docs.", scratch)],
        });

        await backend.run({
          node: {
            id: "implement",
            type: "llm",
            attrs: { allowed_tools: ["read", "agent"] },

          },
          prompt: "do work",
          thread_id: undefined,
          signal: new AbortController().signal,
          run_id: "test-cat-yes",
          workflow_sha: "sha",
        });

        expect(captured).toHaveLength(1);
        const sp = captured[0] ?? "";
        expect(sp).toContain("## Available sub-agents");
        expect(sp).toContain("`reviewer`");
        expect(sp).toContain("Reviews diffs.");
        expect(sp).toContain("`researcher`");
      } finally {
        faux.unregister();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("agent tool absent in pool → catalogue not rendered (cost-control)", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-agent-cat-no-"));
    try {
      const faux = registerFauxProvider();
      try {
        const captured: string[] = [];
        const respond = (ctx: Context, _opts: StreamOptions | undefined): Promise<AssistantMessage> => {
          captured.push(ctx.systemPrompt ?? "");
          return Promise.resolve(fauxAssistantMessage([fauxText("done")], { stopReason: "stop" }));
        };
        faux.setResponses([respond]);

        const model = faux.getModel();
        const registry = new ToolRegistry();
        registry.registerAll(CORE_TOOLS);
        const env = new LocalEnvironment({ cwd: scratch });
        const backend = new PiLlmBackend({
          registry,
          env,
          resolveModel: () => model,
          defaultModel: { provider: model.provider, model: model.id },
          agentDefinitions: [mkDef("reviewer", "Reviews diffs.", scratch)],
        });

        await backend.run({
          node: {
            id: "implement",
            type: "llm",
            attrs: { allowed_tools: ["read"] }, // no `agent` in the pool

          },
          prompt: "do work",
          thread_id: undefined,
          signal: new AbortController().signal,
          run_id: "test-cat-no",
          workflow_sha: "sha",
        });

        expect(captured).toHaveLength(1);
        const sp = captured[0] ?? "";
        expect(sp).not.toContain("## Available sub-agents");
      } finally {
        faux.unregister();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
