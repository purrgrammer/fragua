// emit_output tool — synthesis, force-inclusion, Outcome.outputs population.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventType, NodeAttrs, OutputsDecl } from "@fragua/core";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@fragua/workspace";
import type { AssistantMessage, Context } from "@mariozechner/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { findEmitOutputCall, PiLlmBackend } from "../src/backend.ts";

// ─────────────── findEmitOutputCall unit tests ───────────────

describe("findEmitOutputCall", () => {
  function assistant(...content: unknown[]) {
    return { role: "assistant", content };
  }
  function toolCall(name: string, args: Record<string, unknown>) {
    return { type: "toolCall", id: `tc-${name}`, name, arguments: args };
  }

  test("returns value + isolated for a lone emit_output call", () => {
    const r = findEmitOutputCall([assistant(toolCall("emit_output", { pr_number: "123" }))]);
    expect(r).toEqual({ value: { pr_number: "123" }, isolated: true });
  });

  test("returns null when no emit_output call", () => {
    expect(findEmitOutputCall([])).toBeNull();
    expect(findEmitOutputCall([assistant({ type: "text", text: "done" })])).toBeNull();
    expect(findEmitOutputCall([assistant(toolCall("route", { name: "x" }))])).toBeNull();
  });

  test("last emit_output call wins (shared-thread upstream calls don't shadow)", () => {
    const r = findEmitOutputCall([
      assistant(toolCall("emit_output", { pr_number: "1" })),
      assistant(toolCall("emit_output", { pr_number: "2" })),
    ]);
    expect(r?.value).toEqual({ pr_number: "2" });
  });

  test("isolated=false when emit_output shares a batch with another tool", () => {
    const r = findEmitOutputCall([
      assistant(toolCall("bash", { command: "echo hi" }), toolCall("emit_output", { pr_number: "1" })),
    ]);
    expect(r?.value).toEqual({ pr_number: "1" });
    expect(r?.isolated).toBe(false);
  });
});

// ─────────────── Integration tests with faux provider ───────────────

interface CapturedEvent {
  type: EventType;
  data: Record<string, unknown>;
}

function coreRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.registerAll(CORE_TOOLS);
  return r;
}

interface RunWithOutputsOpts {
  scratch: string;
  registry: ToolRegistry;
  attrs: NodeAttrs;
  responses: AssistantMessage[];
  onContext?: (ctx: Context) => void;
}

async function runWithOutputs(opts: RunWithOutputsOpts): Promise<{
  events: CapturedEvent[];
  outcome: { status: string; outputs?: unknown; failure_reason?: string; route?: string };
}> {
  const faux = registerFauxProvider();
  try {
    const model = faux.getModel();
    const factories = opts.responses.map((msg) => (ctx: Context) => {
      opts.onContext?.(ctx);
      return msg;
    });
    faux.setResponses(factories);

    const env = new LocalEnvironment({ cwd: opts.scratch });
    const backend = new PiLlmBackend({
      registry: opts.registry,
      env,
      resolveModel: () => model,
      defaultModel: { provider: model.provider, model: model.id },
      skills: [],
    });

    const events: CapturedEvent[] = [];
    const outcome = await backend.run({
      node: { id: "n1", type: "llm", attrs: opts.attrs },
      prompt: "produce outputs",
      thread_id: undefined,
      signal: new AbortController().signal,
      run_id: "test-emit-output",
      workflow_sha: "sha",
      emit: async (type, data) => {
        events.push({ type, data });
      },
    });
    return {
      events,
      outcome: outcome as { status: string; outputs?: unknown; failure_reason?: string; route?: string },
    };
  } finally {
    faux.unregister();
  }
}

const PR_OUTPUTS_DECL: OutputsDecl = {
  pr_number: { kind: "string" },
  loc: { kind: "number" },
};

describe("emit_output tool synthesis", () => {
  test("node with outputs: gets emit_output tool in the tool list", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-emit-output-"));
    try {
      let advertised: string[] = [];
      await runWithOutputs({
        scratch,
        registry: coreRegistry(),
        attrs: { outputs: PR_OUTPUTS_DECL },
        responses: [
          fauxAssistantMessage([fauxToolCall("emit_output", { pr_number: "42", loc: 100 }, { id: "tc1" })], {
            stopReason: "toolUse",
          }),
        ],
        onContext: (ctx) => {
          advertised = (ctx.tools ?? []).map((t) => t.name);
        },
      });
      expect(advertised).toContain("emit_output");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("emit_output schema lowers from OutputsDecl with string/number properties", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-emit-schema-"));
    try {
      let emitTool: { name: string; parameters: unknown } | undefined;
      await runWithOutputs({
        scratch,
        registry: coreRegistry(),
        attrs: { outputs: PR_OUTPUTS_DECL },
        responses: [
          fauxAssistantMessage([fauxToolCall("emit_output", { pr_number: "42", loc: 100 }, { id: "tc1" })], {
            stopReason: "toolUse",
          }),
        ],
        onContext: (ctx) => {
          emitTool = (ctx.tools ?? []).find((t) => t.name === "emit_output") as typeof emitTool;
        },
      });
      expect(emitTool).toBeDefined();
      const params = emitTool!.parameters as Record<string, unknown>;
      const props = params["properties"] as Record<string, Record<string, unknown>>;
      expect(props["pr_number"]?.["type"]).toBe("string");
      expect(props["loc"]?.["type"]).toBe("number");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("force-included regardless of allowed_tools restrictions", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-emit-force-"));
    try {
      let advertised: string[] = [];
      await runWithOutputs({
        scratch,
        registry: coreRegistry(),
        attrs: { allowed_tools: ["read"], outputs: PR_OUTPUTS_DECL },
        responses: [
          fauxAssistantMessage([fauxToolCall("emit_output", { pr_number: "7", loc: 5 }, { id: "tc1" })], {
            stopReason: "toolUse",
          }),
        ],
        onContext: (ctx) => {
          advertised = (ctx.tools ?? []).map((t) => t.name);
        },
      });
      expect(advertised).toContain("emit_output");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("successful emit_output populates outcome.outputs", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-emit-outcome-"));
    try {
      const { outcome } = await runWithOutputs({
        scratch,
        registry: coreRegistry(),
        attrs: { outputs: PR_OUTPUTS_DECL },
        responses: [
          fauxAssistantMessage([fauxToolCall("emit_output", { pr_number: "99", loc: 200 }, { id: "tc1" })], {
            stopReason: "toolUse",
          }),
        ],
      });
      expect(outcome.status).toBe("success");
      expect(outcome.outputs).toEqual({ pr_number: "99", loc: 200 });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("agent ends without emit_output → outcome.status='fail' non_retryable", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-emit-missing-"));
    try {
      const { outcome } = await runWithOutputs({
        scratch,
        registry: coreRegistry(),
        attrs: { outputs: PR_OUTPUTS_DECL },
        responses: [fauxAssistantMessage([fauxText("I'm done")], { stopReason: "stop" })],
      });
      expect(outcome.status).toBe("fail");
      expect(outcome.failure_reason).toContain("emit_output");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("emit_output sharing a turn with another tool → outcome.status='fail' (not isolated)", async () => {
    // emit_output terminates the turn, so a tool in the same batch runs blind —
    // its result never reaches the emit. Reject it (mirrors the route exit).
    const scratch = await mkdtemp(join(tmpdir(), "fragua-emit-batch-"));
    try {
      const { outcome } = await runWithOutputs({
        scratch,
        registry: coreRegistry(),
        attrs: { outputs: PR_OUTPUTS_DECL },
        responses: [
          // bash is non-terminating, so the loop runs another turn; the model
          // then stops without re-emitting, leaving the non-isolated emit as the
          // last one the scan finds.
          fauxAssistantMessage(
            [
              fauxToolCall("bash", { command: "echo hi" }, { id: "t1" }),
              fauxToolCall("emit_output", { pr_number: "42", loc: 100 }, { id: "t2" }),
            ],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage([fauxText("done")], { stopReason: "stop" }),
        ],
      });
      expect(outcome.status).toBe("fail");
      expect(outcome.failure_reason).toContain("alone");
      expect(outcome.outputs).toBeUndefined();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("node without outputs: does NOT get emit_output tool", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-no-emit-"));
    try {
      let advertised: string[] = [];
      await runWithOutputs({
        scratch,
        registry: coreRegistry(),
        attrs: {},
        responses: [fauxAssistantMessage([fauxText("done")], { stopReason: "stop" })],
        onContext: (ctx) => {
          advertised = (ctx.tools ?? []).map((t) => t.name);
        },
      });
      expect(advertised).not.toContain("emit_output");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe("outputs and routes are mutually exclusive (MVP)", () => {
  test("a routing node advertises route, not emit_output", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-route-only-"));
    try {
      let advertised: string[] = [];
      const { outcome } = await runWithOutputs({
        scratch,
        registry: coreRegistry(),
        attrs: { routes: ["a", "b"] },
        responses: [
          fauxAssistantMessage([fauxToolCall("route", { name: "a" }, { id: "tc1" })], {
            stopReason: "toolUse",
          }),
        ],
        onContext: (ctx) => {
          if (advertised.length === 0) {
            advertised = (ctx.tools ?? []).map((t) => t.name);
          }
        },
      });
      expect(advertised).toContain("route");
      expect(advertised).not.toContain("emit_output");
      expect(outcome.status).toBe("success");
      expect(outcome.route).toBe("a");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
