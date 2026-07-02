// PiLlmBackend — the MCP materialisation block (backend.ts). A node's
// `mcp_servers` are materialised through the injected `McpConnector` and added to
// the tool set; `allowed_tools` narrows the MCP set only when it names `mcp__*`
// tools, `denied_tools` subtracts, connector `errors` surface as `agent.warning`,
// and the connection is disposed on run completion. Driven against the faux
// provider with a stub connector so no real subprocess is spawned.
//
// Note on names: a materialised tool's fragua name is `mcp__<server>__<tool>`;
// the event `tool_name` is the unsanitised form (`__` → `:`), so the echo tool
// surfaces as `mcp:srv:echo` in `tool.execution_*`.

import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import type { EventType, NodeAttrs } from "@fragua/core";
import {
  type AnyTool,
  CORE_TOOLS,
  LocalEnvironment,
  type McpConnector,
  type McpServerError,
  ToolRegistry,
} from "@fragua/workspace";
import { Type } from "@sinclair/typebox";
import { PiLlmBackend } from "../src/backend.ts";

interface CapturedEvent {
  type: EventType;
  data: Record<string, unknown>;
}

function mcpStubTool(name: string, reply: string): AnyTool {
  return {
    name,
    description: `stub ${name}`,
    parameters: Type.Object({}),
    idempotent: false,
    truncation: { max_chars: 10_000, mode: "tail" },
    async execute() {
      return { text: reply };
    },
  };
}

/** A connector that returns a fixed toolset + errors and counts disposals. */
function stubConnector(spec: { tools: AnyTool[]; errors: McpServerError[]; disposed: { n: number } }): McpConnector {
  return {
    async materialize() {
      return {
        tools: spec.tools,
        errors: spec.errors,
        dispose: async () => {
          spec.disposed.n += 1;
        },
      };
    },
  };
}

function withRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.registerAll(CORE_TOOLS);
  return r;
}

async function runMcp(opts: {
  attrs: NodeAttrs;
  connector: McpConnector;
  script: AssistantMessage[];
}): Promise<{ events: CapturedEvent[]; outcome: { status: string } }> {
  const faux = registerFauxProvider();
  try {
    const model = faux.getModel();
    faux.setResponses(opts.script);
    const backend = new PiLlmBackend({
      registry: withRegistry(),
      env: new LocalEnvironment({ cwd: process.cwd() }),
      resolveModel: () => model,
      defaultModel: { provider: model.provider, model: model.id },
      mcpConnector: opts.connector,
    });
    const events: CapturedEvent[] = [];
    const outcome = await backend.run({
      node: { id: "n1", type: "llm", attrs: opts.attrs },
      prompt: "use the mcp tool",
      thread_id: undefined,
      signal: new AbortController().signal,
      run_id: "test-mcp",
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

const stop = fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });

describe("PiLlmBackend MCP materialisation", () => {
  test("a materialised MCP tool reaches the agent and executes; dispose runs after", async () => {
    const disposed = { n: 0 };
    const connector = stubConnector({ tools: [mcpStubTool("mcp__srv__echo", "echoed!")], errors: [], disposed });
    const { events, outcome } = await runMcp({
      attrs: { mcp_servers: ["srv"] },
      connector,
      script: [
        fauxAssistantMessage([fauxToolCall("mcp__srv__echo", {}, { id: "tc1" })], { stopReason: "toolUse" }),
        stop,
      ],
    });
    expect(outcome.status).not.toBe("fail");
    const ends = events.filter((e) => e.type === "tool.execution_end" && e.data["tool_name"] === "mcp:srv:echo");
    expect(ends.length).toBe(1);
    expect((ends[0]?.data["result"] as { isError?: boolean }).isError).toBeFalsy();
    expect(disposed.n).toBe(1);
  });

  test("denied_tools removes a materialised MCP tool (additive minus deny)", async () => {
    const disposed = { n: 0 };
    const connector = stubConnector({
      tools: [mcpStubTool("mcp__srv__echo", "echoed!"), mcpStubTool("mcp__srv__danger", "boom")],
      errors: [],
      disposed,
    });
    const { events } = await runMcp({
      attrs: { mcp_servers: ["srv"], denied_tools: ["mcp__srv__danger"] },
      connector,
      script: [
        fauxAssistantMessage([fauxToolCall("mcp__srv__danger", {}, { id: "tc1" })], { stopReason: "toolUse" }),
        stop,
      ],
    });
    // The denied tool was never wired → pi-agent-core synthesises a not-found error.
    const end = events.find((e) => e.type === "tool.execution_end" && e.data["tool_name"] === "mcp:srv:danger");
    expect(end).toBeDefined();
    expect(end?.data["is_error"]).toBe(true);
    const result = end?.data["result"] as { content?: Array<{ text?: string }> } | undefined;
    expect((result?.content ?? []).some((b) => typeof b.text === "string" && b.text.includes("not found"))).toBe(true);
    expect(disposed.n).toBe(1);
  });

  test("allowed_tools listing an mcp__ tool restricts MCP tools to those (allowlist)", async () => {
    const disposed = { n: 0 };
    const connector = stubConnector({
      tools: [mcpStubTool("mcp__srv__echo", "echoed!"), mcpStubTool("mcp__srv__danger", "boom")],
      errors: [],
      disposed,
    });
    // Only echo is allowlisted → danger must not be wired even though its server
    // is declared; echo runs.
    const { events, outcome } = await runMcp({
      attrs: { mcp_servers: ["srv"], allowed_tools: ["mcp__srv__echo"] },
      connector,
      script: [
        fauxAssistantMessage(
          [fauxToolCall("mcp__srv__echo", {}, { id: "tc1" }), fauxToolCall("mcp__srv__danger", {}, { id: "tc2" })],
          { stopReason: "toolUse" },
        ),
        stop,
      ],
    });
    expect(outcome.status).not.toBe("fail");
    const echoEnd = events.find((e) => e.type === "tool.execution_end" && e.data["tool_name"] === "mcp:srv:echo");
    expect(echoEnd?.data["is_error"]).toBeFalsy(); // allowlisted → ran
    const dangerEnd = events.find((e) => e.type === "tool.execution_end" && e.data["tool_name"] === "mcp:srv:danger");
    expect(dangerEnd?.data["is_error"]).toBe(true); // not allowlisted → not wired (not-found)
  });

  test("allowed_tools with only core tools does NOT narrow the MCP set (server tools stay)", async () => {
    const disposed = { n: 0 };
    const connector = stubConnector({ tools: [mcpStubTool("mcp__srv__echo", "echoed!")], errors: [], disposed });
    // allowed_tools narrows core to `read` but names no mcp__ tool → the server's
    // tools are untouched, so echo is still available and runs.
    const { events } = await runMcp({
      attrs: { mcp_servers: ["srv"], allowed_tools: ["read"] },
      connector,
      script: [
        fauxAssistantMessage([fauxToolCall("mcp__srv__echo", {}, { id: "tc1" })], { stopReason: "toolUse" }),
        stop,
      ],
    });
    const end = events.find((e) => e.type === "tool.execution_end" && e.data["tool_name"] === "mcp:srv:echo");
    expect(end?.data["is_error"]).toBeFalsy(); // mcp set not narrowed → echo ran
  });

  test("connector errors surface as agent.warning; dispose still runs", async () => {
    const disposed = { n: 0 };
    const connector = stubConnector({
      tools: [],
      errors: [{ server: "broken", message: "boom", kind: "unavailable" }],
      disposed,
    });
    const { events } = await runMcp({
      attrs: { mcp_servers: ["broken"] },
      connector,
      script: [stop],
    });
    const warnings = events.filter((e) => e.type === "agent.warning");
    expect(
      warnings.some((w) => {
        const m = w.data["message"];
        return typeof m === "string" && m.includes("broken") && m.includes("boom");
      }),
    ).toBe(true);
    expect(disposed.n).toBe(1);
  });

  test("allowed_tools naming only an MCP tool doesn't hard-fail before materialisation", async () => {
    const disposed = { n: 0 };
    const connector = stubConnector({ tools: [mcpStubTool("mcp__srv__echo", "echoed!")], errors: [], disposed });
    const { events, outcome } = await runMcp({
      // Only an mcp__ tool in allowed_tools → registry.select() yields nothing,
      // but the tool materialises additively, so the run must proceed.
      attrs: { mcp_servers: ["srv"], allowed_tools: ["mcp__srv__echo"] },
      connector,
      script: [
        fauxAssistantMessage([fauxToolCall("mcp__srv__echo", {}, { id: "tc1" })], { stopReason: "toolUse" }),
        stop,
      ],
    });
    expect(outcome.status).not.toBe("fail");
    const ends = events.filter((e) => e.type === "tool.execution_end" && e.data["tool_name"] === "mcp:srv:echo");
    expect(ends.length).toBe(1);
  });

  test("allowlisting an mcp__ tool but forgetting mcp-servers still fails loudly", async () => {
    const disposed = { n: 0 };
    const connector = stubConnector({ tools: [], errors: [], disposed });
    const { outcome } = await runMcp({
      // No mcp_servers → the mcp__ tool can never materialise, so the empty
      // allowlist must trip the gate rather than run silently tool-less.
      attrs: { allowed_tools: ["mcp__srv__echo"] },
      connector,
      script: [stop],
    });
    expect(outcome.status).toBe("fail");
  });

  test("no mcpConnector wired → node runs without MCP, no crash", async () => {
    const faux = registerFauxProvider();
    try {
      const model = faux.getModel();
      faux.setResponses([stop]);
      const backend = new PiLlmBackend({
        registry: withRegistry(),
        env: new LocalEnvironment({ cwd: process.cwd() }),
        resolveModel: () => model,
        defaultModel: { provider: model.provider, model: model.id },
        // mcpConnector intentionally omitted
      });
      const outcome = await backend.run({
        node: { id: "n1", type: "llm", attrs: { mcp_servers: ["srv"] } },
        prompt: "hi",
        thread_id: undefined,
        signal: new AbortController().signal,
        run_id: "test-mcp-none",
        workflow_sha: "sha",
        emit: async () => {},
      });
      expect(outcome.status).not.toBe("fail");
    } finally {
      faux.unregister();
    }
  });
});
