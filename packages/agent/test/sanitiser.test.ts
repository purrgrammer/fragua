// Tests for the rehydrate sanitiser — see
//
// The sanitiser pairs unpaired toolCall blocks at the tail of a
// rehydrated transcript before pi-ai sees it. Anthropic's API rejects
// `[..., assistant{toolCall}, user{prompt}]` — every tool_use must be
// followed by a user toolResult message. The four branches under test:
//
//   1. transcript already paired                 → reference-equal return
//   2. idempotentOnReplay tool (read)            → re-execute, paired
//      toolResult appended
//   3. non-idempotent tool (bash)                → error toolResult
//      synthesised, execute() never called
//   4. agent tool                                → re-execute via the
//      registry (deterministic-id resume path handles recursion).

import { describe, expect, test } from "bun:test";
import {
  CORE_TOOLS,
  type FraguaToolContext,
  LocalEnvironment,
  type SubagentResult,
  type SubagentSpec,
  sanitiseUnpairedToolCalls,
  ToolRegistry,
} from "@fragua/workspace";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** Collect every unpaired tool_use id (assistant toolCall with no
 *  following toolResult) and every orphan tool_result id (toolResult
 *  with no preceding toolCall). Mirrors the Anthropic API's
 *  validation: the rebuilt priorMessages must never carry either. */
function findUnpairedToolIds(messages: readonly AgentMessage[]): {
  unpairedToolUseIds: string[];
  orphanToolResultIds: string[];
} {
  const seenToolUseIds = new Set<string>();
  const pairedToolUseIds = new Set<string>();
  const orphanToolResultIds: string[] = [];
  for (const m of messages) {
    const role = (m as { role?: string }).role;
    if (role === "assistant" && Array.isArray((m as { content?: unknown }).content)) {
      for (const block of (m as { content: Array<{ type?: string; id?: string }> }).content) {
        if (block?.type === "toolCall" && typeof block.id === "string") {
          seenToolUseIds.add(block.id);
        }
      }
    } else if (role === "toolResult") {
      const id = (m as { toolCallId?: string }).toolCallId;
      if (typeof id !== "string") continue;
      if (seenToolUseIds.has(id)) pairedToolUseIds.add(id);
      else orphanToolResultIds.push(id);
    }
  }
  const unpairedToolUseIds = [...seenToolUseIds].filter((id) => !pairedToolUseIds.has(id));
  return { unpairedToolUseIds, orphanToolResultIds };
}

function freshRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.registerAll(CORE_TOOLS);
  return r;
}

function freshFraguaContext(spawnSubagent?: (spec: SubagentSpec) => Promise<SubagentResult>): FraguaToolContext {
  const base = {
    runId: "r",
    nodeId: "n",
    iteration: 0,
    http: {} as FraguaToolContext["http"],
    emit: () => {},
  };
  return spawnSubagent ? ({ ...base, spawnSubagent } as FraguaToolContext) : (base as FraguaToolContext);
}

describe("sanitiseUnpairedToolCalls", () => {
  test("transcript with all toolCalls already paired is unchanged (referentially)", async () => {
    // Trailing assistant has zero toolCall blocks → no pairing needed,
    // sanitiser returns the same array reference.
    const messages: AgentMessage[] = [
      { role: "user", content: "go", timestamp: 0 } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        provider: "stub",
        model: "stub",
        api: "stub",
        timestamp: 0,
      } as unknown as AgentMessage,
    ];
    const out = await sanitiseUnpairedToolCalls(messages, {
      toolRegistry: freshRegistry(),
      env: new LocalEnvironment({ cwd: "/tmp" }),
      fraguaContext: freshFraguaContext(),
    });
    expect(out).toBe(messages);
  });

  test("idempotent read tool re-executes successfully and yields a paired toolResult", async () => {
    // Pre-seed a file the read tool can resolve. LocalEnvironment.cwd
    // is the scratch dir; read uses env.readFile.
    const cwd = await Bun.$`mktemp -d`.text();
    const dir = cwd.trim();
    await Bun.write(`${dir}/a.txt`, "hello");

    const messages: AgentMessage[] = [
      { role: "user", content: "read it", timestamp: 0 } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc_read", name: "read", arguments: { path: "a.txt" } }],
        stopReason: "toolUse",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        provider: "stub",
        model: "stub",
        api: "stub",
        timestamp: 0,
      } as unknown as AgentMessage,
    ];
    const out = await sanitiseUnpairedToolCalls(messages, {
      toolRegistry: freshRegistry(),
      env: new LocalEnvironment({ cwd: dir }),
      fraguaContext: freshFraguaContext(),
    });
    expect(out.length).toBe(messages.length + 1);
    const tail = out[out.length - 1] as AgentMessage & {
      role: "toolResult";
      toolCallId: string;
      isError: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    expect(tail.role).toBe("toolResult");
    expect(tail.toolCallId).toBe("tc_read");
    expect(tail.isError).toBe(false);
    expect(tail.content[0]?.text).toContain("hello");
  });

  test("non-idempotent tool synthesises an error toolResult instead of re-executing", async () => {
    // The bash tool is idempotent:false and idempotentOnReplay:false
    // (default). Sanitiser must NOT call execute() — re-running a
    // potentially destructive command after partial completion can
    // cascade. Use a registry with a stub bash that flips a flag if
    // called so the assertion is unambiguous.
    const registry = new ToolRegistry();
    let bashCalled = false;
    registry.register({
      name: "bash",
      description: "stub",
      parameters: { type: "object", properties: {} } as never,
      idempotent: false,
      truncation: { max_chars: 100, mode: "tail" },
      async execute() {
        bashCalled = true;
        return { text: "should-not-run", data: { exit_code: 0, duration_ms: 0 } };
      },
    });

    const messages: AgentMessage[] = [
      { role: "user", content: "x", timestamp: 0 } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc_bash", name: "bash", arguments: { command: "rm -rf /" } }],
        stopReason: "toolUse",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        provider: "stub",
        model: "stub",
        api: "stub",
        timestamp: 0,
      } as unknown as AgentMessage,
    ];
    const out = await sanitiseUnpairedToolCalls(messages, {
      toolRegistry: registry,
      env: new LocalEnvironment({ cwd: "/tmp" }),
      fraguaContext: freshFraguaContext(),
    });
    expect(bashCalled).toBe(false);
    expect(out.length).toBe(messages.length + 1);
    const tail = out[out.length - 1] as AgentMessage & {
      role: "toolResult";
      toolCallId: string;
      isError: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    expect(tail.role).toBe("toolResult");
    expect(tail.toolCallId).toBe("tc_bash");
    expect(tail.isError).toBe(true);
    expect(tail.content[0]?.text).toContain("interrupted by a daemon restart");
    expect(tail.content[0]?.text).toContain("'bash'");
  });

  test("orphan toolResult with no preceding toolCall is dropped from the rebuilt transcript", async () => {
    // Crash window: the assistant turn that issued the toolCall was
    // never persisted, but its toolResult landed in the messages
    // table. Rehydrating this verbatim yields
    // `[user, toolResult{id=tc_ghost}]` — Anthropic 400s with
    // "unexpected tool_use_id found in tool_result blocks". The
    // sanitiser must remove the orphan.
    const messages: AgentMessage[] = [
      { role: "user", content: "go", timestamp: 0 } as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "tc_ghost",
        toolName: "read",
        content: [{ type: "text", text: "contents that outlived the crash" }],
        isError: false,
        timestamp: 0,
      } as unknown as AgentMessage,
    ];
    const out = await sanitiseUnpairedToolCalls(messages, {
      toolRegistry: freshRegistry(),
      env: new LocalEnvironment({ cwd: "/tmp" }),
      fraguaContext: freshFraguaContext(),
    });
    const { unpairedToolUseIds, orphanToolResultIds } = findUnpairedToolIds(out);
    expect(orphanToolResultIds).toEqual([]);
    expect(unpairedToolUseIds).toEqual([]);
  });

  test("orphan toolResult in the middle of a transcript is dropped (assistant tail still paired)", async () => {
    // The orphan is not at the tail — there's a clean turn after it.
    // The current implementation only inspects the trailing assistant
    // and would leave the middle-of-transcript orphan untouched,
    // re-triggering the 400 on the next dispatch.
    const cleanAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      stopReason: "stop",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      provider: "stub",
      model: "stub",
      api: "stub",
      timestamp: 0,
    } as unknown as AgentMessage;
    const messages: AgentMessage[] = [
      { role: "user", content: "go", timestamp: 0 } as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "toolu_012RWWkok9GB52PNfYuTVbDb",
        toolName: "read",
        content: [{ type: "text", text: "stranded" }],
        isError: false,
        timestamp: 0,
      } as unknown as AgentMessage,
      { role: "user", content: "continue", timestamp: 0 } as AgentMessage,
      cleanAssistant,
    ];
    const out = await sanitiseUnpairedToolCalls(messages, {
      toolRegistry: freshRegistry(),
      env: new LocalEnvironment({ cwd: "/tmp" }),
      fraguaContext: freshFraguaContext(),
    });
    const { unpairedToolUseIds, orphanToolResultIds } = findUnpairedToolIds(out);
    expect(orphanToolResultIds).toEqual([]);
    expect(unpairedToolUseIds).toEqual([]);
  });

  test("agent tool round-trip resolves to a completed child via the deterministic-id resume path", async () => {
    // The sanitiser re-executes the agent tool through the registry;
    // its execute() reads tool_call_id from opts and forwards on the
    // SubagentSpec. The mock spawnSubagent is the deterministic-id
    // resume entry point in production; here we just verify the
    // round-trip and that tool_call_id was plumbed end-to-end.
    let observedSpec: SubagentSpec | undefined;
    const spawnSubagent = async (spec: SubagentSpec): Promise<SubagentResult> => {
      observedSpec = spec;
      return {
        summary: "child completed",
        subagentId: "deadbeef0000000000000000deadbeef",
        status: "completed",
        totalToolCalls: 0,
      };
    };

    const messages: AgentMessage[] = [
      { role: "user", content: "delegate", timestamp: 0 } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_z", name: "agent", arguments: { prompt: "do the thing" } }],
        stopReason: "toolUse",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        provider: "stub",
        model: "stub",
        api: "stub",
        timestamp: 0,
      } as unknown as AgentMessage,
    ];
    const out = await sanitiseUnpairedToolCalls(messages, {
      toolRegistry: freshRegistry(),
      env: new LocalEnvironment({ cwd: "/tmp" }),
      fraguaContext: freshFraguaContext(spawnSubagent),
    });
    expect(observedSpec).toBeDefined();
    expect(observedSpec!.tool_call_id).toBe("toolu_z");
    expect(observedSpec!.prompt).toBe("do the thing");
    expect(out.length).toBe(messages.length + 1);
    const tail = out[out.length - 1] as AgentMessage & {
      role: "toolResult";
      toolCallId: string;
      isError: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    expect(tail.role).toBe("toolResult");
    expect(tail.toolCallId).toBe("toolu_z");
    expect(tail.isError).toBe(false);
    expect(tail.content[0]?.text).toContain("child completed");
  });
});
