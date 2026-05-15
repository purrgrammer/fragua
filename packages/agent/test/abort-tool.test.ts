// The `abort` tool — the agent backend's self-abort contract.
//
// An agent that cannot proceed calls `abort({ reason })`. The tool is
// force-included on every codergen node (even under `allowed_tools=""`),
// sets `terminate: true` so the loop stops after its batch, and the
// backend turns the call into a non-retryable `fail` outcome that
// workflows wire with `condition="outcome=fail"`.
//
// `findAbortToolCall` is the pure transcript scan; the backend integration
// tests drive a real run against the faux provider.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import type { EventType, NodeAttrs } from "@swarm/core";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { findAbortToolCall, PiCodergenBackend } from "../src/backend.ts";

describe("findAbortToolCall", () => {
  function assistant(...content: unknown[]) {
    return { role: "assistant", content };
  }
  function toolCall(name: string, args: Record<string, unknown>) {
    return { type: "toolCall", id: "tc1", name, arguments: args };
  }

  test("returns the reason for an assistant `abort` tool-call block", () => {
    const r = findAbortToolCall([assistant(toolCall("abort", { reason: "missing $ARGUMENTS" }))]);
    expect(r).toEqual({ reason: "missing $ARGUMENTS" });
  });

  test("returns null for plain text and for other tool calls", () => {
    expect(findAbortToolCall([assistant({ type: "text", text: "all done" })])).toBeNull();
    expect(findAbortToolCall([assistant(toolCall("read", { path: "x" }))])).toBeNull();
    expect(findAbortToolCall([])).toBeNull();
  });

  test("clamps very long reasons to 400 chars", () => {
    const r = findAbortToolCall([assistant(toolCall("abort", { reason: "x".repeat(1000) }))]);
    expect(r?.reason.length).toBe(400);
  });

  test("collapses internal whitespace runs in the reason", () => {
    const r = findAbortToolCall([assistant(toolCall("abort", { reason: "foo\t\t  bar   baz" }))]);
    expect(r?.reason).toBe("foo bar baz");
  });

  test("empty / missing reason falls back to a default", () => {
    expect(findAbortToolCall([assistant(toolCall("abort", { reason: "" }))])?.reason).toContain("without a reason");
    expect(findAbortToolCall([assistant(toolCall("abort", {}))])?.reason).toContain("without a reason");
  });

  test("finds the abort even when it precedes a later assistant message", () => {
    // The abort can land in a non-terminating batch alongside other tool
    // calls; the loop runs one more turn but the call is still in history.
    const r = findAbortToolCall([
      assistant(toolCall("abort", { reason: "blocked" }), toolCall("read", { path: "x" })),
      { role: "toolResult", content: [{ type: "text", text: "..." }] },
      assistant({ type: "text", text: "trailing prose" }),
    ]);
    expect(r?.reason).toBe("blocked");
  });

  test("first abort call wins", () => {
    const r = findAbortToolCall([
      assistant(toolCall("abort", { reason: "first" })),
      assistant(toolCall("abort", { reason: "second" })),
    ]);
    expect(r?.reason).toBe("first");
  });
});

interface CapturedEvent {
  type: EventType;
  data: Record<string, unknown>;
}

function coreRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.registerAll(CORE_TOOLS);
  return r;
}

async function runWithAbort(opts: {
  scratch: string;
  registry: ToolRegistry;
  attrs: NodeAttrs;
  reason: string;
}): Promise<{
  events: CapturedEvent[];
  outcome: { status: string; failure_reason?: string; non_retryable?: boolean };
}> {
  const faux = registerFauxProvider();
  try {
    const model = faux.getModel();
    // Call 1 emits the `abort` toolCall; the tool sets `terminate: true`
    // so the loop stops after that batch. The trailing response is a
    // safety net that should go unused.
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("abort", { reason: opts.reason }, { id: "tc1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")], { stopReason: "stop" }),
    ]);

    const env = new LocalEnvironment({ cwd: opts.scratch });
    const backend = new PiCodergenBackend({
      registry: opts.registry,
      env,
      resolveModel: () => model,
      defaultModel: { provider: model.provider, model: model.id },
      skills: [],
    });

    const events: CapturedEvent[] = [];
    const outcome = await backend.run({
      node: { id: "n1", shape: "box", attrs: opts.attrs, classes: [] },
      prompt: "do the thing",
      context: {},
      thread_id: undefined,
      fidelity: "compact",
      signal: new AbortController().signal,
      run_id: "test-abort-tool",
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

describe("PiCodergenBackend abort tool wiring", () => {
  test("an `abort` tool call yields a non-retryable fail outcome", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-abort-outcome-"));
    try {
      const { outcome } = await runWithAbort({
        scratch,
        registry: coreRegistry(),
        attrs: {},
        reason: "target file does not exist",
      });
      expect(outcome.status).toBe("fail");
      expect(outcome.non_retryable).toBe(true);
      expect(outcome.failure_reason).toBe("target file does not exist");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("abort tool is force-included even when node.attrs.allowed_tools omits it", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-abort-allow-"));
    try {
      const { events, outcome } = await runWithAbort({
        scratch,
        registry: coreRegistry(),
        // allowed_tools deliberately excludes "abort" — force-include must
        // still wire it. This is the empty-allowed-tools case the
        // abort-test.dot smoke test exercises end-to-end.
        attrs: { allowed_tools: ["read"] },
        reason: "blocked by missing input",
      });
      // tool.execution_end with tool_name === "abort" proves the tool was
      // wired AND the call resolved (vs. unknown-tool error).
      const ends = events.filter((e) => e.type === "tool.execution_end" && e.data["tool_name"] === "abort");
      expect(ends.length).toBe(1);
      expect(outcome.status).toBe("fail");
      expect(outcome.failure_reason).toBe("blocked by missing input");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("abort tool is force-included even when node.attrs.denied_tools lists it", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-abort-deny-"));
    try {
      const { events, outcome } = await runWithAbort({
        scratch,
        registry: coreRegistry(),
        attrs: { denied_tools: ["abort"] },
        reason: "contradictory constraints",
      });
      const ends = events.filter((e) => e.type === "tool.execution_end" && e.data["tool_name"] === "abort");
      expect(ends.length).toBe(1);
      expect(outcome.status).toBe("fail");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
