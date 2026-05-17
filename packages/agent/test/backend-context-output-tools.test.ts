// PiCodergenBackend \u2014 `context_set` and `emit_output` tools are
// force-included regardless of node `allowed_tools` / `denied_tools`.
//
// Mirrors backend-skill-tool.test.ts: drive a real run against the
// faux provider, script the model to call one of the new tools, and
// observe that the call resolves through the real wiring (not an
// unknown-tool error from pi-agent-core).

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import type { EventType, NodeAttrs } from "@swarm/core";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { PiCodergenBackend } from "../src/backend.ts";

interface CapturedEvent {
  type: EventType;
  data: Record<string, unknown>;
}

function freshRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.registerAll(CORE_TOOLS);
  return r;
}

async function runOnce(opts: {
  scratch: string;
  toolName: "context_set" | "emit_output";
  toolArgs: Record<string, unknown>;
  attrs: NodeAttrs;
}): Promise<{
  events: CapturedEvent[];
  outcome: { status: string; contextWrites?: unknown; pendingOutput?: unknown };
}> {
  const faux = registerFauxProvider();
  try {
    const model = faux.getModel();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(opts.toolName, opts.toolArgs, { id: "tc1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")], { stopReason: "stop" }),
    ]);
    const env = new LocalEnvironment({ cwd: opts.scratch });
    const backend = new PiCodergenBackend({
      registry: freshRegistry(),
      env,
      resolveModel: () => model,
      defaultModel: { provider: model.provider, model: model.id },
    });
    const events: CapturedEvent[] = [];
    const outcome = await backend.run({
      node: { id: "n1", shape: "box", attrs: opts.attrs, classes: [] },
      prompt: "use the tool",
      context: {},
      thread_id: undefined,
      fidelity: "compact",
      signal: new AbortController().signal,
      run_id: "test-cs-eo",
      workflow_sha: "sha",
      emit: async (type, data) => {
        events.push({ type, data });
      },
    });
    return { events, outcome };
  } finally {
    faux.unregister();
  }
}

describe("PiCodergenBackend context_set + emit_output force-include", () => {
  test("context_set is present even when denied_tools lists it", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-cs-deny-"));
    try {
      const { events, outcome } = await runOnce({
        scratch,
        toolName: "context_set",
        toolArgs: { key: "severity", value: "high" },
        attrs: { denied_tools: ["context_set"] },
      });
      expect(outcome.status).not.toBe("fail");
      const ends = events.filter((e) => e.type === "tool.execution_end" && e.data["tool_name"] === "context_set");
      expect(ends.length).toBe(1);
      const result = ends[0]!.data["result"] as { isError?: boolean; details?: { data?: { ok?: boolean } } };
      expect(result.isError).toBeFalsy();
      expect(result.details?.data?.ok).toBe(true);
      // Outcome carries the captured write so handler-bridge can route it.
      expect(outcome.contextWrites).toEqual([{ key: "severity", value: "high" }]);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("context_set is present even when allowed_tools omits it", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-cs-allow-"));
    try {
      const { events, outcome } = await runOnce({
        scratch,
        toolName: "context_set",
        toolArgs: { key: "category", value: "billing" },
        attrs: { allowed_tools: ["read"] },
      });
      expect(outcome.status).not.toBe("fail");
      const ends = events.filter((e) => e.type === "tool.execution_end" && e.data["tool_name"] === "context_set");
      expect(ends.length).toBe(1);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("emit_output is present even when denied_tools lists it", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-eo-deny-"));
    try {
      const { events, outcome } = await runOnce({
        scratch,
        toolName: "emit_output",
        toolArgs: { data: { label: "billing" } },
        attrs: { denied_tools: ["emit_output"] },
      });
      expect(outcome.status).not.toBe("fail");
      const ends = events.filter((e) => e.type === "tool.execution_end" && e.data["tool_name"] === "emit_output");
      expect(ends.length).toBe(1);
      expect(outcome.pendingOutput).toEqual({ data: { label: "billing" } });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("emit_output is present even when allowed_tools omits it", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-eo-allow-"));
    try {
      const { events, outcome } = await runOnce({
        scratch,
        toolName: "emit_output",
        toolArgs: { data: "plain string output" },
        attrs: { allowed_tools: ["read"] },
      });
      expect(outcome.status).not.toBe("fail");
      const ends = events.filter((e) => e.type === "tool.execution_end" && e.data["tool_name"] === "emit_output");
      expect(ends.length).toBe(1);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
