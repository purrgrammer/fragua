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

import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  CORE_TOOLS,
  type FraguaToolContext,
  LocalEnvironment,
  sanitiseUnpairedToolCalls,
  ToolRegistry,
} from "@fragua/workspace";

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

/** Mirror pi-ai's `transformMessages` drop rule: assistant turns whose
 *  stopReason is "error" | "aborted" are removed before the provider
 *  sees them. The bug we regress against is sanitiser output that's
 *  internally paired but orphans a tool_result ONCE pi-ai applies this
 *  drop downstream — so the faithful assertion runs the drop, then
 *  checks for orphans, reproducing the exact Anthropic 400 condition. */
function dropAbortedAssistants(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.filter((m) => {
    const sr = m as { role?: string; stopReason?: string };
    return !(sr.role === "assistant" && (sr.stopReason === "error" || sr.stopReason === "aborted"));
  });
}

function freshRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.registerAll(CORE_TOOLS);
  return r;
}

function freshFraguaContext(): FraguaToolContext {
  return {
    runId: "r",
    nodeId: "n",
    iteration: 0,
    http: {} as FraguaToolContext["http"],
    emit: () => {},
  } as FraguaToolContext;
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

  test("aborted trailing assistant turn is dropped, not paired", async () => {
    // The node was aborted (abort / timeout / cancel) while the agent's
    // last turn was mid-tool-execution, so the assistant was persisted
    // with stopReason "aborted" and its read calls never produced
    // results. pi-ai's transformMessages drops aborted turns; if we
    // synthesised results for them they'd outlive the turn and orphan.
    // The sanitiser must drop the turn entirely, leaving the prior clean
    // toolResult as the tail — NOT re-execute the reads.
    const cwd = (await Bun.$`mktemp -d`.text()).trim();
    await Bun.write(`${cwd}/a.txt`, "hello");
    const messages: AgentMessage[] = [
      { role: "user", content: "go", timestamp: 0 } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc_first", name: "read", arguments: { path: "a.txt" } }],
        stopReason: "toolUse",
        provider: "stub",
        model: "stub",
        api: "stub",
        timestamp: 0,
      } as unknown as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "tc_first",
        toolName: "read",
        content: [{ type: "text", text: "hello" }],
        isError: false,
        timestamp: 0,
      } as unknown as AgentMessage,
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tc_aborted_a", name: "read", arguments: { path: "a.txt" } },
          { type: "toolCall", id: "tc_aborted_b", name: "read", arguments: { path: "a.txt" } },
        ],
        stopReason: "aborted",
        provider: "stub",
        model: "stub",
        api: "stub",
        timestamp: 0,
      } as unknown as AgentMessage,
    ];
    const out = await sanitiseUnpairedToolCalls(messages, {
      toolRegistry: freshRegistry(),
      env: new LocalEnvironment({ cwd }),
      fraguaContext: freshFraguaContext(),
    });
    // The aborted turn and any synthesis for it are gone; the tail is the
    // surviving clean toolResult, and nothing is unpaired.
    expect(out.length).toBe(3);
    expect(out[out.length - 1]?.role).toBe("toolResult");
    // The actual 400 surfaced only after pi-ai dropped the aborted turn
    // downstream: synthesised results for tc_aborted_a/b outlived their
    // tool_use. Reproduce that drop and assert no orphan survives.
    const { unpairedToolUseIds, orphanToolResultIds } = findUnpairedToolIds(dropAbortedAssistants(out));
    expect(orphanToolResultIds).toEqual([]);
    expect(unpairedToolUseIds).toEqual([]);
  });

  test("results already persisted for an aborted turn are dropped with it", async () => {
    // Abort landed between two tool calls: toolResult(A) was persisted,
    // B never ran. pi-ai drops the assistant and keeps toolResult(A) →
    // orphan. The tail here is a toolResult, so the trailing-assistant
    // path can't catch it; the forward scan must drop A alongside the
    // aborted turn that issued it.
    const messages: AgentMessage[] = [
      { role: "user", content: "go", timestamp: 0 } as AgentMessage,
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tc_a", name: "read", arguments: { path: "a.txt" } },
          { type: "toolCall", id: "tc_b", name: "read", arguments: { path: "b.txt" } },
        ],
        stopReason: "aborted",
        provider: "stub",
        model: "stub",
        api: "stub",
        timestamp: 0,
      } as unknown as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "tc_a",
        toolName: "read",
        content: [{ type: "text", text: "partial read that outlived the abort" }],
        isError: false,
        timestamp: 0,
      } as unknown as AgentMessage,
    ];
    const out = await sanitiseUnpairedToolCalls(messages, {
      toolRegistry: freshRegistry(),
      env: new LocalEnvironment({ cwd: "/tmp" }),
      fraguaContext: freshFraguaContext(),
    });
    const { unpairedToolUseIds, orphanToolResultIds } = findUnpairedToolIds(dropAbortedAssistants(out));
    expect(orphanToolResultIds).toEqual([]);
    expect(unpairedToolUseIds).toEqual([]);
    // Only the user message survives — both the aborted turn and its
    // stranded result are gone.
    expect(out.length).toBe(1);
    expect(out[0]?.role).toBe("user");
  });
});
