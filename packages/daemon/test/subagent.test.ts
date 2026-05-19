// Sub-agent inline-codergen behaviour: a parent's `agent` tool call
// drives a fresh codergen call against the same parent run, with all
// observability events forwarded onto the parent's stream stamped with
// a `subagent_id`. No child run, no separate stream, no `fact.run_*`
// for the sub-agent.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { CodergenInput, EventType, ExecutionEnvironment, Outcome } from "@swarm/core";
import { ok } from "@swarm/core";
import { SqliteStore } from "@swarm/store";
import type { Skill } from "@swarm/workspace";
import { CORE_TOOLS, ToolRegistry } from "@swarm/workspace";
import { makeSpawnSubagent } from "../src/spawn-subagent.ts";

function freshStore(): SqliteStore {
  return new SqliteStore({ path: ":memory:" });
}

function seedParent(store: SqliteStore, parentRunId: string): void {
  store.saveWorkflow("wf", "t", "digraph{}");
  store.enqueueRun({ runId: parentRunId, workflowSha: "wf" });
}

function freshRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.registerAll(CORE_TOOLS);
  return r;
}

// Stub env for the StubBackend — never invoked because the backend
// records inputs and returns canned outcomes without touching the FS.
const STUB_ENV: ExecutionEnvironment = {
  cwd: () => "/tmp/stub",
  projectCwd: () => "/tmp/stub",
  exists: async () => false,
  readFile: async () => "",
  writeFile: async () => undefined,
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
  listDir: async () => [],
  glob: async () => [],
};

class StubBackend {
  public readonly inputs: CodergenInput[] = [];
  constructor(private readonly factory: (input: CodergenInput) => Outcome | Promise<Outcome>) {}
  async run(input: CodergenInput): Promise<Outcome> {
    this.inputs.push(input);
    if (input.persistMessage) {
      input.persistMessage({
        role: "assistant",
        content: [{ type: "text", text: "child summary text" }],
        stopReason: "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        provider: "stub",
        model: "stub",
      } as Parameters<NonNullable<CodergenInput["persistMessage"]>>[0]);
    }
    return await this.factory(input);
  }
}

/** Capture parent-stream emit calls for assertions. */
function recordingEmit() {
  const events: Array<{ type: EventType; data: Record<string, unknown> }> = [];
  const emit = async (type: EventType, data: Record<string, unknown>) => {
    events.push({ type, data });
  };
  return { events, emit };
}

describe("makeSpawnSubagent", () => {
  test("parent calls agent → sub-agent runs inline → returns summary; emits subagent.start/end on parent's stream", async () => {
    const store = freshStore();
    seedParent(store, "parent-1");
    const registry = freshRegistry();
    const backend = new StubBackend(() => ok({ notes: "" }));
    const ctrl = new AbortController();
    const { events, emit } = recordingEmit();

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-1",
        parentNodeId: "plan",
        parentIteration: 2,
        parentSystemPrompt: "PARENT BASE PROMPT",
        parentSkills: [],
        parentProvider: "anthropic",
        parentModel: "claude-haiku-4-5",
        parentEnv: STUB_ENV,
        parentEmit: emit,
      },
    );

    const result = await spawn({ prompt: "do the thing", name: "step 1", tool_call_id: "toolu_p1" });

    expect(result.summary).toBe("child summary text");
    expect(result.status).toBe("completed");
    expect(result.subagentId).toMatch(/^[0-9a-f]{32}$/);

    // No child run row, no kind discriminator — sub-agents are not runs.
    expect(store.getState(result.subagentId)).toBeNull();

    // Parent stream got bracketing subagent.start / subagent.end with
    // matching subagent_id; everything in between (when there are
    // tools / cost) carries the same id on payload.
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("subagent.start");
    expect(types.at(-1)).toBe("subagent.end");
    const start = events.find((e) => e.type === "subagent.start")!;
    expect(start.data["subagent_id"]).toBe(result.subagentId);
    expect(start.data["parent_node_id"]).toBe("plan");
    expect(start.data["iteration"]).toBe(2);
    expect(start.data["name"]).toBe("step 1");
    expect(start.data["model"]).toBe("claude-haiku-4-5");
    const end = events.find((e) => e.type === "subagent.end")!;
    expect(end.data["subagent_id"]).toBe(result.subagentId);
    expect(end.data["status"]).toBe("completed");
    expect(end.data["summary_chars"]).toBe("child summary text".length);

    // Sub-agent transcript landed in the parent run's messages table
    // under a distinct nodeId so it doesn't pollute the main thread.
    const messages = store.getMessages("parent-1");
    expect(messages.length).toBeGreaterThan(0);
    const subagentNode = `__subagent:${result.subagentId}`;
    expect(messages.every((m) => m.nodeId === subagentNode)).toBe(true);

    store.close();
  });

  test("agent tool is structurally absent from sub-agent's pool even when parent allowed it", async () => {
    const store = freshStore();
    seedParent(store, "parent-2");
    const registry = freshRegistry();
    let observedChildPool: string[] | undefined;
    const backend = new StubBackend((input) => {
      observedChildPool = (input.node.attrs["allowed_tools"] as string[] | undefined)?.slice();
      return ok({ notes: "" });
    });
    const ctrl = new AbortController();
    const { emit } = recordingEmit();

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-2",
        parentNodeId: "plan",
        parentIteration: 0,
        parentSystemPrompt: "P",
        parentSkills: [],
        parentProvider: "anthropic",
        parentModel: "claude-haiku-4-5",
        parentEnv: STUB_ENV,
        parentEmit: emit,
        parentAllowedTools: ["read", "write", "agent"],
      },
    );

    // Spec omitted; child inherits parentAllowedTools, then `agent`
    // is stripped — so the child sees [read, write].
    await spawn({ prompt: "x", tool_call_id: "toolu_p2" });
    expect(observedChildPool).toBeDefined();
    expect(observedChildPool!).not.toContain("agent");
    expect(observedChildPool!.sort()).toEqual(["read", "write"]);

    store.close();
  });

  test("empty resolved pool errors out instead of spawning a useless sub-agent", async () => {
    // Degenerate config: parent declares only `agent` (a pure
    // spawn-only pool). After stripAgentTool the child has nothing.
    // Without the guard the sub-agent would burn tokens reasoning
    // about how to make progress with no tools; surface a clear
    // halt to the LLM instead.
    const store = freshStore();
    seedParent(store, "parent-empty");
    const registry = freshRegistry();
    let backendCalled = false;
    const backend = new StubBackend(() => {
      backendCalled = true;
      return ok({ notes: "" });
    });
    const ctrl = new AbortController();
    const { emit } = recordingEmit();

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-empty",
        parentNodeId: "plan",
        parentIteration: 0,
        parentSystemPrompt: "P",
        parentSkills: [],
        parentProvider: "anthropic",
        parentModel: "claude-haiku-4-5",
        parentEnv: STUB_ENV,
        parentEmit: emit,
        parentAllowedTools: ["agent"],
      },
    );

    const result = await spawn({ prompt: "x", tool_call_id: "toolu_pe" });
    expect(result.status).toBe("halted");
    expect(result.haltReason).toBe("empty_tool_pool");
    expect(backendCalled).toBe(false);

    store.close();
  });

  test("parent cancellation propagates to sub-agent via in-process AbortSignal", async () => {
    const store = freshStore();
    seedParent(store, "parent-3");
    const registry = freshRegistry();
    let observedSignal: AbortSignal | undefined;
    const backend = new StubBackend((input) => {
      observedSignal = input.signal;
      return ok({ notes: "" });
    });
    const ctrl = new AbortController();
    const { emit } = recordingEmit();

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-3",
        parentNodeId: "plan",
        parentIteration: 0,
        parentSystemPrompt: "P",
        parentSkills: [],
        parentProvider: "anthropic",
        parentModel: "claude-haiku-4-5",
        parentEnv: STUB_ENV,
        parentEmit: emit,
      },
    );

    const parentSpec = new AbortController();
    parentSpec.abort();
    await spawn({ prompt: "x", signal: parentSpec.signal, tool_call_id: "toolu_p3" });

    expect(observedSignal?.aborted).toBe(true);
    store.close();
  });

  test("pause-cancelled sub-agent: partial transcript persists; re-spawn with same tool_call_id hydrates it", async () => {
    // End-to-end resume contract for the budget-pause case the user
    // flagged: when a parent run pauses mid-flight, the sub-agent's
    // work-so-far must survive and be hydratable by a subsequent
    // spawn that reuses the same deterministic id.
    //
    // The deterministic subagent_id is sha256(parentRunId, parentNodeId,
    // parentIteration, tool_call_id), so a re-execution path that
    // preserves tool_call_id (sanitiseUnpairedToolCalls on rehydrate)
    // picks the same id and the prior transcript is replayed.
    //
    // KNOWN GAP: graceful pause/resume through pi-agent today persists
    // the cancelled toolResult as PAIRED. sanitiseUnpairedToolCalls
    // never sees an unpaired tool call to re-execute, and any LLM-
    // initiated retry generates a NEW tool_call_id → new subagent_id →
    // hydration is bypassed. This test proves the lower-level
    // mechanism works; closing the gap end-to-end needs a follow-up
    // that either leaves the cancelled toolCall unpaired on pause or
    // exposes the prior subagent_id to the LLM for explicit resume.
    const store = freshStore();
    seedParent(store, "parent-resume-cancel");
    const registry = freshRegistry();
    const ctrl = new AbortController();

    // Spawn 1: emits two assistant messages (durable), then suspends
    // until aborted.
    const backend1 = new StubBackend((input) => {
      input.persistMessage?.({
        role: "user",
        content: [{ type: "text", text: "work prompt" }],
      } as Parameters<NonNullable<CodergenInput["persistMessage"]>>[0]);
      input.persistMessage?.({
        role: "assistant",
        content: [{ type: "text", text: "partial progress so far" }],
        stopReason: "toolUse",
      } as Parameters<NonNullable<CodergenInput["persistMessage"]>>[0]);
      return new Promise<Outcome>((_, reject) => {
        const onAbort = (): void => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (input.signal?.aborted) onAbort();
        else input.signal?.addEventListener("abort", onAbort, { once: true });
      });
    });

    const parentCtxBase = {
      parentRunId: "parent-resume-cancel",
      parentNodeId: "orchestrate",
      parentIteration: 0,
      parentSystemPrompt: "P",
      parentSkills: [],
      parentProvider: "anthropic",
      parentModel: "claude-haiku-4-5",
      parentEnv: STUB_ENV,
      parentEmit: recordingEmit().emit,
    } as const;

    const spawn1 = makeSpawnSubagent(
      { store, registry, backend: backend1, shutdownSignal: ctrl.signal },
      parentCtxBase,
    );

    const parentSpec = new AbortController();
    const result1Promise = spawn1({ prompt: "do task", signal: parentSpec.signal, tool_call_id: "toolu_resume" });
    // Wait for backend to register its abort listener.
    for (let i = 0; i < 50 && backend1.inputs.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    parentSpec.abort();
    const result1 = await result1Promise;
    expect(result1.status).toBe("cancelled");

    // Determine the subagentNodeId the spawn used and verify the
    // partial transcript is on disk.
    const subagentId = createHash("sha256")
      .update(`parent-resume-cancel orchestrate 0 toolu_resume`)
      .digest("hex")
      .slice(0, 32);
    const subagentNodeId = `__subagent:${subagentId}`;
    const persisted = store.getMessages("parent-resume-cancel", { nodeId: subagentNodeId });
    // StubBackend prepends one canned assistant message; factory adds
    // user + assistant. All three rows are durable, even though the
    // backend rejected on abort.
    expect(persisted.length).toBe(3);
    const persistedRoles = persisted.map((m) => (m.content as { role: string }).role);
    expect(persistedRoles).toEqual(["assistant", "user", "assistant"]);

    // Spawn 2: same tool_call_id → same deterministic subagent_id →
    // crash-resilience hydration MUST load the partial transcript and
    // pass it to backend.run as priorMessages.
    const backend2 = new StubBackend(() => ok({ notes: "" }));
    const spawn2 = makeSpawnSubagent(
      { store, registry, backend: backend2, shutdownSignal: ctrl.signal },
      parentCtxBase,
    );
    await spawn2({ prompt: "do task", tool_call_id: "toolu_resume" });

    const seenPrior = backend2.inputs[0]?.priorMessages;
    expect(seenPrior).toBeDefined();
    // Hydration replays every persisted non-system message — the canned
    // assistant, the user prompt, the partial assistant turn.
    expect(seenPrior!.length).toBe(3);
    const lastText = (seenPrior![2] as { content: Array<{ type: string; text?: string }> }).content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    expect(lastText).toBe("partial progress so far");

    store.close();
  });

  test("mid-flight parent abort propagates into sub-agent's already-running backend signal", async () => {
    // The pre-flight test above covers the easy case (parent.signal
    // already aborted before spawn). This test covers the live case:
    // the sub-agent's backend.run() is suspended awaiting an LLM stream
    // when the parent's budget gate trips and aborts the parent's
    // signal. The cascade must reach the child's input.signal so the
    // backend unwinds — otherwise children burn provider spend long
    // after the parent run is paused.
    const store = freshStore();
    seedParent(store, "parent-mid");
    const registry = freshRegistry();
    let childSignal: AbortSignal | undefined;
    let backendEntered = false;
    const backend = new StubBackend((input) => {
      childSignal = input.signal;
      backendEntered = true;
      return new Promise<Outcome>((_resolve, reject) => {
        const onAbort = (): void => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (input.signal?.aborted) onAbort();
        else input.signal?.addEventListener("abort", onAbort, { once: true });
      });
    });
    const ctrl = new AbortController();
    const { emit } = recordingEmit();

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-mid",
        parentNodeId: "orchestrate",
        parentIteration: 0,
        parentSystemPrompt: "P",
        parentSkills: [],
        parentProvider: "anthropic",
        parentModel: "claude-haiku-4-5",
        parentEnv: STUB_ENV,
        parentEmit: emit,
      },
    );

    const parentSpec = new AbortController();
    const spawnPromise = spawn({ prompt: "x", signal: parentSpec.signal, tool_call_id: "toolu_pm" });
    // Wait for the stub backend to enter and register its abort listener.
    for (let i = 0; i < 50 && !backendEntered; i++) await new Promise((r) => setTimeout(r, 5));
    expect(backendEntered).toBe(true);
    expect(childSignal?.aborted).toBe(false);

    parentSpec.abort();
    const result = await spawnPromise;

    expect(childSignal?.aborted).toBe(true);
    expect(result.status).toBe("cancelled");
    store.close();
  });

  test("filtered skills land on the sub-agent's node attrs", async () => {
    const store = freshStore();
    seedParent(store, "parent-4");
    const registry = freshRegistry();
    let observedSkills: string[] | undefined;
    const backend = new StubBackend((input) => {
      observedSkills = (input.node.attrs["skills"] as string[] | undefined)?.slice();
      return ok({ notes: "" });
    });
    const ctrl = new AbortController();
    const { emit } = recordingEmit();

    const skillA: Skill = {
      name: "swarm-debug",
      description: "post-mortem",
      location: "/skills/swarm-debug/SKILL.md",
      skill_dir: "/skills/swarm-debug",
      sha256: "deadbeef",
      bytes: 100,
      scope: "user",
      source_dir: "/skills/swarm-debug",
    };
    const skillB: Skill = {
      ...skillA,
      name: "design",
      description: "ui design",
      location: "/skills/design/SKILL.md",
      skill_dir: "/skills/design",
      source_dir: "/skills/design",
    };

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-4",
        parentNodeId: "plan",
        parentIteration: 0,
        parentSystemPrompt: "P",
        parentSkills: [skillA, skillB],
        parentProvider: "anthropic",
        parentModel: "claude-haiku-4-5",
        parentEnv: STUB_ENV,
        parentEmit: emit,
      },
    );

    await spawn({ prompt: "x", skills: ["design"], tool_call_id: "toolu_p4" });
    expect(observedSkills).toEqual(["design"]);
    store.close();
  });

  test("oversized parent system prompt does not leak onto the sub-agent (no inheritance of parent's assembled bloat)", async () => {
    // Two regressions in one. First, the earlier child-run design
    // stuffed the system prompt into `run_state.routing` (8 KB cap)
    // and broke for any realistic parent prompt — sub-agents now run
    // inline so routing isn't involved. Second, an interim design
    // inherited the parent's fully-assembled system prompt verbatim,
    // bloating every sub-agent call by 10s of KB and feeding tools
    // the sub-agent couldn't even use. Sub-agents now get a fresh
    // minimal prompt by default; explicit `system_prompt` overrides.
    const store = freshStore();
    seedParent(store, "parent-large");
    const registry = freshRegistry();
    let observedSystemPrompt: string | undefined;
    const backend = new StubBackend((input) => {
      observedSystemPrompt =
        typeof input.node.attrs["system_prompt"] === "string"
          ? (input.node.attrs["system_prompt"] as string)
          : undefined;
      return ok({ notes: "" });
    });
    const ctrl = new AbortController();
    const { emit } = recordingEmit();

    const oversized = "X".repeat(12_000); // 12 KB

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-large",
        parentNodeId: "plan",
        parentIteration: 0,
        parentSystemPrompt: oversized,
        parentSkills: [],
        parentProvider: "anthropic",
        parentModel: "claude-haiku-4-5",
        parentEnv: STUB_ENV,
        parentEmit: emit,
      },
    );

    // Must not throw, must not leak the parent's bloat onto the child.
    const result = await spawn({ prompt: "user prompt", name: "regression", tool_call_id: "toolu_pl" });
    expect(result.status).toBe("completed");
    expect(observedSystemPrompt).toBeUndefined();
    store.close();
  });

  test("explicit spec.system_prompt is forwarded to the sub-agent's node.attrs", async () => {
    const store = freshStore();
    seedParent(store, "parent-explicit");
    const registry = freshRegistry();
    let observedSystemPrompt: string | undefined;
    const backend = new StubBackend((input) => {
      observedSystemPrompt =
        typeof input.node.attrs["system_prompt"] === "string"
          ? (input.node.attrs["system_prompt"] as string)
          : undefined;
      return ok({ notes: "" });
    });
    const ctrl = new AbortController();
    const { emit } = recordingEmit();

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-explicit",
        parentNodeId: "plan",
        parentIteration: 0,
        parentSystemPrompt: "PARENT BLOAT",
        parentSkills: [],
        parentProvider: "anthropic",
        parentModel: "claude-haiku-4-5",
        parentEnv: STUB_ENV,
        parentEmit: emit,
      },
    );

    await spawn({ prompt: "x", system_prompt: "FOCUSED REVIEWER PERSONA", tool_call_id: "toolu_pe2" });
    expect(observedSystemPrompt).toBeDefined();
    expect(observedSystemPrompt!).toContain("FOCUSED REVIEWER PERSONA");
    expect(observedSystemPrompt!).not.toContain("PARENT BLOAT");
    store.close();
  });

  test("subagent.start payload splits `name` (label) from `agent_def` (resolved profile)", async () => {
    const store = freshStore();
    seedParent(store, "parent-agentname");
    const registry = freshRegistry();
    const backend = new StubBackend(() => ok({ notes: "" }));
    const ctrl = new AbortController();
    const { events, emit } = recordingEmit();

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-agentname",
        parentNodeId: "plan",
        parentIteration: 0,
        parentSystemPrompt: "P",
        parentSkills: [],
        parentProvider: "anthropic",
        parentModel: "claude-haiku-4-5",
        parentEnv: STUB_ENV,
        parentEmit: emit,
      },
    );

    // Both fields populated independently — the inline `name` is the
    // free-form caller label, `agentName` is the resolved profile.
    await spawn({ prompt: "x", agentName: "reviewer", name: "label-only", tool_call_id: "toolu_pa1" });
    const start = events.find((e) => e.type === "subagent.start")!;
    expect(start.data["name"]).toBe("label-only");
    expect(start.data["agent_def"]).toBe("reviewer");
    store.close();
  });

  test("subagent.start payload omits both `name` and `agent_def` for a bare spawn", async () => {
    const store = freshStore();
    seedParent(store, "parent-bare");
    const registry = freshRegistry();
    const backend = new StubBackend(() => ok({ notes: "" }));
    const ctrl = new AbortController();
    const { events, emit } = recordingEmit();

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-bare",
        parentNodeId: "plan",
        parentIteration: 0,
        parentSystemPrompt: "P",
        parentSkills: [],
        parentProvider: "anthropic",
        parentModel: "claude-haiku-4-5",
        parentEnv: STUB_ENV,
        parentEmit: emit,
      },
    );

    await spawn({ prompt: "x", tool_call_id: "toolu_pb" });
    const start = events.find((e) => e.type === "subagent.start")!;
    expect(start.data).not.toHaveProperty("name");
    expect(start.data).not.toHaveProperty("agent_def");
    store.close();
  });

  test("subagent.start payload carries only `agent_def` when invoked via def with no inline name", async () => {
    const store = freshStore();
    seedParent(store, "parent-def-only");
    const registry = freshRegistry();
    const backend = new StubBackend(() => ok({ notes: "" }));
    const ctrl = new AbortController();
    const { events, emit } = recordingEmit();

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-def-only",
        parentNodeId: "plan",
        parentIteration: 0,
        parentSystemPrompt: "P",
        parentSkills: [],
        parentProvider: "anthropic",
        parentModel: "claude-haiku-4-5",
        parentEnv: STUB_ENV,
        parentEmit: emit,
      },
    );

    await spawn({ prompt: "x", agentName: "reviewer", tool_call_id: "toolu_pd" });
    const start = events.find((e) => e.type === "subagent.start")!;
    expect(start.data).not.toHaveProperty("name");
    expect(start.data["agent_def"]).toBe("reviewer");
    store.close();
  });

  test("subagent.end carries per-spawn cost rollup summed from forwarded cost.recorded events", async () => {
    // Bug regression: SubagentEndData previously declared only
    // {status, summary_chars, total_tool_calls, halt_reason?} — consumers
    // reading subagent.end.payload.costUsd / .totalTokens got undefined,
    // even though every cost.recorded the child emitted flowed onto the
    // parent's stream and into the parent's accumulators. Fix: track a
    // per-spawn delta inside subagentEmit's closure and stamp it onto
    // subagent.end.
    const store = freshStore();
    seedParent(store, "parent-cost");
    const registry = freshRegistry();
    // Backend emits two cost.recorded events through the spawn's emit
    // channel — exactly what the real codergen backend does at every
    // assistant message_end via packages/agent/src/event-bridge.ts.
    const backend = new StubBackend(async (input) => {
      await input.emit?.("cost.recorded", {
        provider: "stub",
        model: "stub",
        stop_reason: "stop",
        input_tokens: 100,
        output_tokens: 40,
        cache_read_tokens: 10,
        cache_write_tokens: 5,
        total_tokens: 155,
        cost_usd: 0.012,
        cost_input_usd: 0.008,
        cost_output_usd: 0.004,
        cost_cache_read_usd: 0,
        cost_cache_write_usd: 0,
      });
      await input.emit?.("cost.recorded", {
        provider: "stub",
        model: "stub",
        stop_reason: "stop",
        input_tokens: 200,
        output_tokens: 60,
        cache_read_tokens: 20,
        cache_write_tokens: 0,
        total_tokens: 280,
        cost_usd: 0.03,
        cost_input_usd: 0.02,
        cost_output_usd: 0.01,
        cost_cache_read_usd: 0,
        cost_cache_write_usd: 0,
      });
      return ok({ notes: "" });
    });
    const ctrl = new AbortController();
    const { events, emit } = recordingEmit();

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-cost",
        parentNodeId: "plan",
        parentIteration: 0,
        parentSystemPrompt: "P",
        parentSkills: [],
        parentProvider: "anthropic",
        parentModel: "claude-haiku-4-5",
        parentEnv: STUB_ENV,
        parentEmit: emit,
      },
    );

    await spawn({ prompt: "x", name: "with-cost", tool_call_id: "toolu_pc" });
    const end = events.find((e) => e.type === "subagent.end")!;
    expect(end.data["costUsd"]).toBeCloseTo(0.042, 6);
    expect(end.data["totalTokens"]).toBe(155 + 280);
    expect(end.data["inputTokens"]).toBe(300);
    expect(end.data["outputTokens"]).toBe(100);
    expect(end.data["cacheReadTokens"]).toBe(30);
    expect(end.data["cacheWriteTokens"]).toBe(5);
    store.close();
  });

  test("subagent.end cost rollup defaults to zero when no cost.recorded fired", async () => {
    // Default-zero contract: required-number fields, not optional.
    // A spawn that never produced a cost.recorded (e.g. a pure halt
    // before any LLM call) must still surface 0/0/... so consumers
    // don't have to re-introduce undefined-checks at every read.
    const store = freshStore();
    seedParent(store, "parent-zero-cost");
    const registry = freshRegistry();
    const backend = new StubBackend(() => ok({ notes: "" }));
    const ctrl = new AbortController();
    const { events, emit } = recordingEmit();

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-zero-cost",
        parentNodeId: "plan",
        parentIteration: 0,
        parentSystemPrompt: "P",
        parentSkills: [],
        parentProvider: "anthropic",
        parentModel: "claude-haiku-4-5",
        parentEnv: STUB_ENV,
        parentEmit: emit,
      },
    );

    await spawn({ prompt: "x", tool_call_id: "toolu_pz" });
    const end = events.find((e) => e.type === "subagent.end")!;
    expect(end.data["costUsd"]).toBe(0);
    expect(end.data["totalTokens"]).toBe(0);
    expect(end.data["inputTokens"]).toBe(0);
    expect(end.data["outputTokens"]).toBe(0);
    expect(end.data["cacheReadTokens"]).toBe(0);
    expect(end.data["cacheWriteTokens"]).toBe(0);
    store.close();
  });

  test("def-supplied model/provider override parent's on the synthesised child node", async () => {
    const store = freshStore();
    seedParent(store, "parent-modeloverride");
    const registry = freshRegistry();
    let observedProvider: string | undefined;
    let observedModel: string | undefined;
    const backend = new StubBackend((input) => {
      observedProvider =
        typeof input.node.attrs["llm_provider"] === "string" ? (input.node.attrs["llm_provider"] as string) : undefined;
      observedModel =
        typeof input.node.attrs["llm_model"] === "string" ? (input.node.attrs["llm_model"] as string) : undefined;
      return ok({ notes: "" });
    });
    const ctrl = new AbortController();
    const { events, emit } = recordingEmit();

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-modeloverride",
        parentNodeId: "plan",
        parentIteration: 0,
        parentSystemPrompt: "P",
        parentSkills: [],
        parentProvider: "anthropic",
        parentModel: "claude-opus-4-7",
        parentEnv: STUB_ENV,
        parentEmit: emit,
      },
    );

    await spawn({
      prompt: "x",
      provider: "openai",
      model: "gpt-5",
      tool_call_id: "toolu_pm",
    });

    expect(observedProvider).toBe("openai");
    expect(observedModel).toBe("gpt-5");
    // The boundary marker also records the child's resolved (overridden)
    // provider/model so traces don't lie about which model ran.
    const start = events.find((e) => e.type === "subagent.start")!;
    expect(start.data["provider"]).toBe("openai");
    expect(start.data["model"]).toBe("gpt-5");
    store.close();
  });

  test("deterministic subagent_id is sha256(parentRunId, parentNodeId, parentIteration, tool_call_id) truncated to 32 hex chars", async () => {
    const store = freshStore();
    seedParent(store, "parent-det");
    const registry = freshRegistry();
    const backend = new StubBackend(() => ok({ notes: "" }));
    const ctrl = new AbortController();
    const { emit } = recordingEmit();

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-det",
        parentNodeId: "plan",
        parentIteration: 7,
        parentSystemPrompt: "P",
        parentSkills: [],
        parentProvider: "anthropic",
        parentModel: "claude-haiku-4-5",
        parentEnv: STUB_ENV,
        parentEmit: emit,
      },
    );

    const a = await spawn({ prompt: "x", tool_call_id: "toolu_same" });
    const b = await spawn({ prompt: "y", tool_call_id: "toolu_same" });
    expect(a.subagentId).toMatch(/^[0-9a-f]{32}$/);
    expect(b.subagentId).toBe(a.subagentId);
    store.close();
  });

  test("parallel siblings sharing parentIteration but different tool_call_ids hash to distinct subagent_ids", async () => {
    const store = freshStore();
    seedParent(store, "parent-siblings");
    const registry = freshRegistry();
    const backend = new StubBackend(() => ok({ notes: "" }));
    const ctrl = new AbortController();
    const { emit } = recordingEmit();

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-siblings",
        parentNodeId: "plan",
        parentIteration: 0,
        parentSystemPrompt: "P",
        parentSkills: [],
        parentProvider: "anthropic",
        parentModel: "claude-haiku-4-5",
        parentEnv: STUB_ENV,
        parentEmit: emit,
      },
    );

    const a = await spawn({ prompt: "branch a", tool_call_id: "toolu_a" });
    const b = await spawn({ prompt: "branch b", tool_call_id: "toolu_b" });
    expect(a.subagentId).not.toBe(b.subagentId);
    expect(a.subagentId).toMatch(/^[0-9a-f]{32}$/);
    expect(b.subagentId).toMatch(/^[0-9a-f]{32}$/);
    store.close();
  });

  test("respawn with same deterministic id passes priorMessages from messages table to backend.run", async () => {
    const store = freshStore();
    seedParent(store, "parent-resume");
    const registry = freshRegistry();
    const backend = new StubBackend(() => ok({ notes: "" }));
    const ctrl = new AbortController();
    const { emit } = recordingEmit();

    // Compute the deterministic id we'll be respawning under so we
    // can pre-seed the messages table at __subagent:<id>.
    const det = createHash("sha256")
      .update(`parent-resume\u0000plan\u00000\u0000toolu_resume`)
      .digest("hex")
      .slice(0, 32);
    const seededNodeId = `__subagent:${det}`;

    // Pre-seed: one system row (must be filtered out), one user, one
    // assistant with a toolCall (the in-flight pre-crash turn).
    store.appendMessage("parent-resume", {
      content: { role: "system", content: "prior system", timestamp: 0 },
      nodeId: seededNodeId,
      iteration: 0,
    });
    store.appendMessage("parent-resume", {
      content: { role: "user", content: "prior user prompt", timestamp: 0 },
      nodeId: seededNodeId,
      iteration: 0,
    });
    store.appendMessage("parent-resume", {
      content: {
        role: "assistant",
        content: [
          { type: "text", text: "thinking" },
          { type: "toolCall", id: "toolu_inner", name: "read", arguments: { path: "a" } },
        ],
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
      } as Parameters<NonNullable<CodergenInput["persistMessage"]>>[0],
      nodeId: seededNodeId,
      iteration: 0,
    });

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-resume",
        parentNodeId: "plan",
        parentIteration: 0,
        parentSystemPrompt: "P",
        parentSkills: [],
        parentProvider: "anthropic",
        parentModel: "claude-haiku-4-5",
        parentEnv: STUB_ENV,
        parentEmit: emit,
      },
    );

    await spawn({ prompt: "resume", tool_call_id: "toolu_resume" });

    expect(backend.inputs).toHaveLength(1);
    const seenPrior = backend.inputs[0]!.priorMessages;
    expect(seenPrior).toBeDefined();
    expect(seenPrior!.length).toBe(2);
    expect(seenPrior!.every((m) => m.role !== "system")).toBe(true);
    expect(seenPrior![0]!.role).toBe("user");
    expect(seenPrior![1]!.role).toBe("assistant");
    store.close();
  });

  test("cumulative cost rollup on resumed subagent.end seeds from prior subagent.end events for same subagent_id", async () => {
    const store = freshStore();
    seedParent(store, "parent-cumcost");
    const registry = freshRegistry();
    const ctrl = new AbortController();

    const det = createHash("sha256")
      .update(`parent-cumcost\u0000plan\u00000\u0000toolu_cum`)
      .digest("hex")
      .slice(0, 32);

    // Spawn 1 — the daemon crashed mid-flight, so the bracket lands
    // as cancelled with partial cost. Use a custom backend that
    // bypasses the StubBackend's persistMessage helper (which would
    // write a stopReason:'stop' assistant row, tripping the resume
    // short-circuit on spawn 2) and instead emits two cost.recorded
    // events plus a partial-success outcome. Persisted messages stay
    // mid-flight so spawn 2 actually exercises the LLM path with the
    // cumulative seed.
    class PartialBackend {
      public readonly inputs: CodergenInput[] = [];
      constructor(private readonly factory: (input: CodergenInput) => Promise<Outcome>) {}
      async run(input: CodergenInput): Promise<Outcome> {
        this.inputs.push(input);
        return await this.factory(input);
      }
    }
    const backend1 = new PartialBackend(async (input) => {
      await input.emit?.("cost.recorded", {
        provider: "stub",
        model: "stub",
        stop_reason: "stop",
        input_tokens: 100,
        output_tokens: 40,
        cache_read_tokens: 10,
        cache_write_tokens: 5,
        total_tokens: 155,
        cost_usd: 0.025,
        cost_input_usd: 0,
        cost_output_usd: 0,
        cost_cache_read_usd: 0,
        cost_cache_write_usd: 0,
      });
      await input.emit?.("cost.recorded", {
        provider: "stub",
        model: "stub",
        stop_reason: "stop",
        input_tokens: 50,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 70,
        cost_usd: 0.015,
        cost_input_usd: 0,
        cost_output_usd: 0,
        cost_cache_read_usd: 0,
        cost_cache_write_usd: 0,
      });
      return ok({ notes: "" });
    });

    // parentEmit that ALSO persists to the store so subagent.end
    // lands as an actual event row — spawn 2 reads it via
    // getEventsByType. Mirrors what the daemon's real bridge does.
    const parentEmit1 = async (type: EventType, data: Record<string, unknown>) => {
      store.appendObservabilityEvents("parent-cumcost", [{ type, payload: data }]);
    };

    const spawn1 = makeSpawnSubagent(
      { store, registry, backend: backend1, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-cumcost",
        parentNodeId: "plan",
        parentIteration: 0,
        parentSystemPrompt: "P",
        parentSkills: [],
        parentProvider: "anthropic",
        parentModel: "claude-haiku-4-5",
        parentEnv: STUB_ENV,
        parentEmit: parentEmit1,
      },
    );

    const r1 = await spawn1({ prompt: "go", tool_call_id: "toolu_cum" });
    expect(r1.subagentId).toBe(det);
    const spawn1Ends = store
      .getEventsByType("parent-cumcost", "subagent.end")
      .filter((e) => (e.payload as { subagent_id?: string }).subagent_id === det);
    expect(spawn1Ends.length).toBe(1);
    expect((spawn1Ends[0]!.payload as { costUsd: number }).costUsd).toBeCloseTo(0.04, 6);

    // Spawn 2 — same deterministic id (same parent ctx + tool_call_id),
    // backend emits another $0.06 of cost. The resumed bracket's
    // subagent.end must surface 0.04 + 0.06 = $0.10 cumulative.
    const backend2 = new PartialBackend(async (input) => {
      await input.emit?.("cost.recorded", {
        provider: "stub",
        model: "stub",
        stop_reason: "stop",
        input_tokens: 200,
        output_tokens: 60,
        cache_read_tokens: 20,
        cache_write_tokens: 10,
        total_tokens: 290,
        cost_usd: 0.06,
        cost_input_usd: 0,
        cost_output_usd: 0,
        cost_cache_read_usd: 0,
        cost_cache_write_usd: 0,
      });
      return ok({ notes: "" });
    });
    const spawn2Events: Array<{ type: EventType; data: Record<string, unknown> }> = [];
    const parentEmit2 = async (type: EventType, data: Record<string, unknown>) => {
      spawn2Events.push({ type, data });
      store.appendObservabilityEvents("parent-cumcost", [{ type, payload: data }]);
    };
    const spawn2 = makeSpawnSubagent(
      { store, registry, backend: backend2, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-cumcost",
        parentNodeId: "plan",
        parentIteration: 0,
        parentSystemPrompt: "P",
        parentSkills: [],
        parentProvider: "anthropic",
        parentModel: "claude-haiku-4-5",
        parentEnv: STUB_ENV,
        parentEmit: parentEmit2,
      },
    );
    await spawn2({ prompt: "resume", tool_call_id: "toolu_cum" });

    const end2 = spawn2Events.find((e) => e.type === "subagent.end");
    expect(end2).toBeDefined();
    expect(end2!.data["costUsd"]).toBeCloseTo(0.1, 6);
    expect(end2!.data["totalTokens"]).toBe(155 + 70 + 290);
    expect(end2!.data["inputTokens"]).toBe(100 + 50 + 200);
    expect(end2!.data["outputTokens"]).toBe(40 + 20 + 60);
    expect(end2!.data["cacheReadTokens"]).toBe(10 + 0 + 20);
    expect(end2!.data["cacheWriteTokens"]).toBe(5 + 0 + 10);
    store.close();
  });

  test("already-completed transcript bypasses backend.run and emits subagent.resumed before subagent.end", async () => {
    const store = freshStore();
    seedParent(store, "parent-postsummary");
    const registry = freshRegistry();
    const backend = new StubBackend(() => ok({ notes: "" }));
    const ctrl = new AbortController();
    const { events, emit } = recordingEmit();

    // The pre-crash spawn produced a final answer (stopReason:"stop",
    // text-only blocks) and persisted it. The daemon died before the
    // parent's tool-execute promise resolved — so the resumed bracket
    // must skip the LLM, synthesise SubagentResult, and emit
    // resumed→end.
    const det = createHash("sha256")
      .update(`parent-postsummary\u0000plan\u00000\u0000toolu_done`)
      .digest("hex")
      .slice(0, 32);
    const seededNodeId = `__subagent:${det}`;
    store.appendMessage("parent-postsummary", {
      content: { role: "user", content: "go", timestamp: 0 },
      nodeId: seededNodeId,
      iteration: 0,
    });
    store.appendMessage("parent-postsummary", {
      content: {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_inner", name: "read", arguments: { path: "a" } }],
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
      } as unknown as Parameters<NonNullable<CodergenInput["persistMessage"]>>[0],
      nodeId: seededNodeId,
      iteration: 0,
    });
    store.appendMessage("parent-postsummary", {
      content: {
        role: "toolResult",
        toolCallId: "toolu_inner",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        details: {},
        isError: false,
        timestamp: 0,
      },
      nodeId: seededNodeId,
      iteration: 0,
    });
    store.appendMessage("parent-postsummary", {
      content: {
        role: "assistant",
        content: [{ type: "text", text: "final summary text" }],
        stopReason: "stop",
        usage: {
          input: 5,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 10,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        provider: "stub",
        model: "stub",
        api: "stub",
        timestamp: 0,
      } as unknown as Parameters<NonNullable<CodergenInput["persistMessage"]>>[0],
      nodeId: seededNodeId,
      iteration: 0,
    });

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-postsummary",
        parentNodeId: "plan",
        parentIteration: 0,
        parentSystemPrompt: "P",
        parentSkills: [],
        parentProvider: "anthropic",
        parentModel: "claude-haiku-4-5",
        parentEnv: STUB_ENV,
        parentEmit: emit,
      },
    );

    const result = await spawn({ prompt: "resume", tool_call_id: "toolu_done" });

    expect(backend.inputs).toHaveLength(0);
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("final summary text");
    expect(result.totalToolCalls).toBe(1);

    // Bracket on resume: subagent.resumed immediately before subagent.end.
    // No subagent.start — the original is already in the parent's stream
    // from the pre-crash bracket.
    const types = events.map((e) => e.type);
    expect(types).not.toContain("subagent.start");
    const resumedIdx = types.indexOf("subagent.resumed");
    const endIdx = types.indexOf("subagent.end");
    expect(resumedIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBe(resumedIdx + 1);
    const resumed = events[resumedIdx]!;
    expect(resumed.data["subagent_id"]).toBe(result.subagentId);
    expect(resumed.data["reason"]).toBe("already_completed");
    const end = events[endIdx]!;
    expect(end.data["status"]).toBe("completed");
    expect(end.data["summary_chars"]).toBe("final summary text".length);
    expect(end.data["total_tool_calls"]).toBe(1);
    store.close();
  });

  describe("content-addressed pending-resume FIFO queue", () => {
    // The user-facing semantic: a cancelled sub-agent enters a queue
    // keyed by (parent_run, parent_node, iteration, args_hash). The
    // NEXT agent-tool spawn with matching args pops the oldest pending
    // entry and resumes it (replays its transcript), so an LLM retry
    // that re-emits the same prompt automatically picks up where the
    // cancelled bracket left off — no `resume_subagent_id` parameter,
    // no LLM cooperation. See spawn-subagent.ts:findPendingResumeCandidate.

    test("cancelled spawn + retry with matching args_hash resumes the prior bracket (FIFO)", async () => {
      const store = freshStore();
      seedParent(store, "parent-cx-1");
      const registry = freshRegistry();
      const ctrl = new AbortController();
      // parentEmit must persist to the store so findPendingResumeCandidate
      // (which reads subagent.start/end/resumed via store.getEventsByType)
      // sees the prior bracket. Mirrors the real daemon's parentEmit
      // (appendObservabilityEvents under the parent's runId).
      const events: Array<{ type: EventType; data: Record<string, unknown> }> = [];
      const emit = async (type: EventType, data: Record<string, unknown>) => {
        events.push({ type, data });
        store.appendObservabilityEvents("parent-cx-1", [{ type, payload: data }]);
      };

      // Spawn 1: persists a partial transcript, returns cancelled.
      // The childCtrl is aborted via pre-aborted spec.signal so
      // mapOutcomeStatus maps the throw to "cancelled" (not "halted").
      const backend1 = new StubBackend((input) => {
        input.persistMessage?.({
          role: "user",
          content: [{ type: "text", text: "lens 1 prompt" }],
        } as Parameters<NonNullable<CodergenInput["persistMessage"]>>[0]);
        input.persistMessage?.({
          role: "assistant",
          content: [{ type: "text", text: "halfway through the review…" }],
          stopReason: "toolUse",
        } as Parameters<NonNullable<CodergenInput["persistMessage"]>>[0]);
        const err = new Error("cancelled mid-flight");
        err.name = "AbortError";
        throw err;
      });
      const preAborted1 = new AbortController();
      preAborted1.abort();
      const spawn1 = makeSpawnSubagent(
        { store, registry, backend: backend1, shutdownSignal: ctrl.signal },
        {
          parentRunId: "parent-cx-1",
          parentNodeId: "dispatch",
          parentIteration: 0,
          parentSystemPrompt: "P",
          parentSkills: [],
          parentProvider: "anthropic",
          parentModel: "claude-opus-4-7",
          parentEnv: STUB_ENV,
          parentEmit: emit,
        },
      );
      const ARGS_HASH = "deadbeefcafef00d11112222333344ff";
      const r1 = await spawn1({
        prompt: "lens 1",
        signal: preAborted1.signal,
        tool_call_id: "toolu_first",
        args_hash: ARGS_HASH,
      });
      expect(r1.status).toBe("cancelled");
      const startEvent = events.find((e) => e.type === "subagent.start")!;
      expect(startEvent.data["args_hash"]).toBe(ARGS_HASH);
      const cancelledId = r1.subagentId;

      // Spawn 2: different tool_call_id (LLM minted a fresh one on
      // retry) but SAME args_hash → must reuse cancelledId so the
      // hydration path replays the partial transcript.
      let seenPriorOnRetry: AgentMessage[] | undefined;
      const backend2 = new StubBackend((input) => {
        seenPriorOnRetry = input.priorMessages as AgentMessage[] | undefined;
        return ok({ notes: "" });
      });
      const spawn2 = makeSpawnSubagent(
        { store, registry, backend: backend2, shutdownSignal: ctrl.signal },
        {
          parentRunId: "parent-cx-1",
          parentNodeId: "dispatch",
          parentIteration: 0,
          parentSystemPrompt: "P",
          parentSkills: [],
          parentProvider: "anthropic",
          parentModel: "claude-opus-4-7",
          parentEnv: STUB_ENV,
          parentEmit: emit,
        },
      );
      const r2 = await spawn2({
        prompt: "lens 1",
        tool_call_id: "toolu_retry_fresh_id",
        args_hash: ARGS_HASH,
      });
      // FIFO pop → same subagent_id as the cancelled spawn.
      expect(r2.subagentId).toBe(cancelledId);
      // Backend saw the prior transcript on input.priorMessages.
      expect(seenPriorOnRetry).toBeDefined();
      expect(seenPriorOnRetry!.length).toBeGreaterThanOrEqual(2);
      // The resume emits subagent.resumed{reason:"transcript_hydrated"}
      // for the in-flight case, NOT a fresh subagent.start.
      const retryEvents = events.filter((e) => e.data["subagent_id"] === cancelledId);
      const starts = retryEvents.filter((e) => e.type === "subagent.start");
      expect(starts.length).toBe(1); // only the original start
      const resumeds = retryEvents.filter((e) => e.type === "subagent.resumed");
      expect(resumeds.length).toBe(1);
      expect(resumeds[0]!.data["reason"]).toBe("transcript_hydrated");

      // Spawn 3: same args_hash AGAIN, but the queue is now empty
      // (cancelled bracket was consumed) → falls back to a fresh
      // deterministic id, NOT cancelledId.
      const backend3 = new StubBackend(() => ok({ notes: "" }));
      const spawn3 = makeSpawnSubagent(
        { store, registry, backend: backend3, shutdownSignal: ctrl.signal },
        {
          parentRunId: "parent-cx-1",
          parentNodeId: "dispatch",
          parentIteration: 0,
          parentSystemPrompt: "P",
          parentSkills: [],
          parentProvider: "anthropic",
          parentModel: "claude-opus-4-7",
          parentEnv: STUB_ENV,
          parentEmit: emit,
        },
      );
      const r3 = await spawn3({
        prompt: "lens 1",
        tool_call_id: "toolu_third",
        args_hash: ARGS_HASH,
      });
      expect(r3.subagentId).not.toBe(cancelledId);
      store.close();
    });

    test("only `cancelled` brackets are popped — completed ones don't pollute the queue", async () => {
      const store = freshStore();
      seedParent(store, "parent-cx-2");
      const registry = freshRegistry();
      const ctrl = new AbortController();
      const emit = async (type: EventType, data: Record<string, unknown>) => {
        store.appendObservabilityEvents("parent-cx-2", [{ type, payload: data }]);
      };

      // Spawn 1: completes successfully.
      const backend1 = new StubBackend(() => ok({ notes: "" }));
      const spawn1 = makeSpawnSubagent(
        { store, registry, backend: backend1, shutdownSignal: ctrl.signal },
        {
          parentRunId: "parent-cx-2",
          parentNodeId: "dispatch",
          parentIteration: 0,
          parentSystemPrompt: "P",
          parentSkills: [],
          parentProvider: "anthropic",
          parentModel: "claude-opus-4-7",
          parentEnv: STUB_ENV,
          parentEmit: emit,
        },
      );
      const ARGS_HASH = "1111222233334444aaaabbbbccccdddd";
      const r1 = await spawn1({
        prompt: "lens A",
        tool_call_id: "toolu_a",
        args_hash: ARGS_HASH,
      });
      expect(r1.status).toBe("completed");

      // Spawn 2: same args, but the queue is empty (only a completed
      // bracket exists, which doesn't pollute the queue) → fresh id.
      const backend2 = new StubBackend(() => ok({ notes: "" }));
      const spawn2 = makeSpawnSubagent(
        { store, registry, backend: backend2, shutdownSignal: ctrl.signal },
        {
          parentRunId: "parent-cx-2",
          parentNodeId: "dispatch",
          parentIteration: 0,
          parentSystemPrompt: "P",
          parentSkills: [],
          parentProvider: "anthropic",
          parentModel: "claude-opus-4-7",
          parentEnv: STUB_ENV,
          parentEmit: emit,
        },
      );
      const r2 = await spawn2({
        prompt: "lens A",
        tool_call_id: "toolu_a2",
        args_hash: ARGS_HASH,
      });
      expect(r2.subagentId).not.toBe(r1.subagentId);
      store.close();
    });

    test("args_hash scope is per (parent_node_id, iteration) — different scopes don't share the queue", async () => {
      const store = freshStore();
      seedParent(store, "parent-cx-3");
      const registry = freshRegistry();
      const ctrl = new AbortController();
      const emit = async (type: EventType, data: Record<string, unknown>) => {
        store.appendObservabilityEvents("parent-cx-3", [{ type, payload: data }]);
      };

      // Cancelled spawn under parentNodeId="dispatch", iteration=0.
      const backend1 = new StubBackend(() => {
        const err = new Error("cancelled");
        err.name = "AbortError";
        throw err;
      });
      const spawnAt = (parentNodeId: string, parentIteration: number) =>
        makeSpawnSubagent(
          { store, registry, backend: backend1, shutdownSignal: ctrl.signal },
          {
            parentRunId: "parent-cx-3",
            parentNodeId,
            parentIteration,
            parentSystemPrompt: "P",
            parentSkills: [],
            parentProvider: "anthropic",
            parentModel: "claude-opus-4-7",
            parentEnv: STUB_ENV,
            parentEmit: emit,
          },
        );
      const ARGS_HASH = "abcdef0011223344556677889900aabb";
      const preAborted = new AbortController();
      preAborted.abort();
      const r1 = await spawnAt(
        "dispatch",
        0,
      )({ prompt: "X", signal: preAborted.signal, tool_call_id: "toolu_x1", args_hash: ARGS_HASH });
      expect(r1.status).toBe("cancelled");

      // Retry with SAME args_hash but under a DIFFERENT parent node →
      // no match (scope differs), fresh id.
      const backend2 = new StubBackend(() => ok({ notes: "" }));
      const spawn2 = makeSpawnSubagent(
        { store, registry, backend: backend2, shutdownSignal: ctrl.signal },
        {
          parentRunId: "parent-cx-3",
          parentNodeId: "other-node",
          parentIteration: 0,
          parentSystemPrompt: "P",
          parentSkills: [],
          parentProvider: "anthropic",
          parentModel: "claude-opus-4-7",
          parentEnv: STUB_ENV,
          parentEmit: emit,
        },
      );
      const r2 = await spawn2({ prompt: "X", tool_call_id: "toolu_x2", args_hash: ARGS_HASH });
      expect(r2.subagentId).not.toBe(r1.subagentId);

      // Retry under SAME parent node but DIFFERENT iteration → also
      // no match (goal-gate retarget shouldn't bleed in).
      const backend3 = new StubBackend(() => ok({ notes: "" }));
      const spawn3 = makeSpawnSubagent(
        { store, registry, backend: backend3, shutdownSignal: ctrl.signal },
        {
          parentRunId: "parent-cx-3",
          parentNodeId: "dispatch",
          parentIteration: 1,
          parentSystemPrompt: "P",
          parentSkills: [],
          parentProvider: "anthropic",
          parentModel: "claude-opus-4-7",
          parentEnv: STUB_ENV,
          parentEmit: emit,
        },
      );
      const r3 = await spawn3({ prompt: "X", tool_call_id: "toolu_x3", args_hash: ARGS_HASH });
      expect(r3.subagentId).not.toBe(r1.subagentId);

      // Retry under same scope as the cancelled spawn → MATCHES.
      const backend4 = new StubBackend(() => ok({ notes: "" }));
      const spawn4 = spawnAt("dispatch", 0);
      // Need backend4 wired; rebuild spawn with the correct backend.
      void backend4; // (StubBackend wiring below)
      const spawn4b = makeSpawnSubagent(
        { store, registry, backend: backend4, shutdownSignal: ctrl.signal },
        {
          parentRunId: "parent-cx-3",
          parentNodeId: "dispatch",
          parentIteration: 0,
          parentSystemPrompt: "P",
          parentSkills: [],
          parentProvider: "anthropic",
          parentModel: "claude-opus-4-7",
          parentEnv: STUB_ENV,
          parentEmit: emit,
        },
      );
      void spawn4;
      const r4 = await spawn4b({ prompt: "X", tool_call_id: "toolu_x4", args_hash: ARGS_HASH });
      expect(r4.subagentId).toBe(r1.subagentId);
      store.close();
    });

    test("multi-cycle: a bracket resumed then re-cancelled becomes pending again (live regression from run 01ks0gr40avtet7tw9)", async () => {
      // Found live during a review.dot run: the first pause/resume
      // cycle correctly resumed all 4 brackets via FIFO. The SECOND
      // pause then re-cancelled those resumed brackets, and the
      // third spawn batch minted fresh ids because the consumed
      // check was binary ("ever resumed → forever consumed") rather
      // than seq-relative ("resumed since the latest cancellation").
      // Result: every pause past the first abandons sub-agent
      // accumulated work. Same shape for raise & resume.
      const store = freshStore();
      seedParent(store, "parent-cx-multicycle");
      const ARGS_HASH = "cccc0000aaaaeeeeffffbbbbdddd1111";
      const SID = "abc0000000000000000000000000000a";
      // Event sequence: start → end(cancelled) → resumed (first
      // resume) → end(cancelled) (second pause re-cancels it).
      // After this the bracket MUST be findable as pending again.
      store.appendObservabilityEvents("parent-cx-multicycle", [
        {
          type: "subagent.start",
          payload: {
            subagent_id: SID,
            parent_node_id: "dispatch",
            iteration: 0,
            provider: "anthropic",
            model: "claude-opus-4-7",
            tool_call_id: "toolu_orig",
            args_hash: ARGS_HASH,
          },
        },
        {
          type: "subagent.end",
          payload: {
            subagent_id: SID,
            status: "cancelled",
            summary_chars: 0,
            total_tool_calls: 0,
            costUsd: 0,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
        { type: "subagent.resumed", payload: { subagent_id: SID, reason: "transcript_hydrated" } },
        {
          type: "subagent.end",
          payload: {
            subagent_id: SID,
            status: "cancelled",
            summary_chars: 0,
            total_tool_calls: 0,
            costUsd: 0,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
      ]);

      const registry = freshRegistry();
      const ctrl = new AbortController();
      const emit = async (type: EventType, data: Record<string, unknown>) => {
        store.appendObservabilityEvents("parent-cx-multicycle", [{ type, payload: data }]);
      };
      const backend = new StubBackend(() => ok({ notes: "" }));
      const spawn = makeSpawnSubagent(
        { store, registry, backend, shutdownSignal: ctrl.signal },
        {
          parentRunId: "parent-cx-multicycle",
          parentNodeId: "dispatch",
          parentIteration: 0,
          parentSystemPrompt: "P",
          parentSkills: [],
          parentProvider: "anthropic",
          parentModel: "claude-opus-4-7",
          parentEnv: STUB_ENV,
          parentEmit: emit,
        },
      );
      const r = await spawn({
        prompt: "lens",
        tool_call_id: "toolu_retry_after_second_pause",
        args_hash: ARGS_HASH,
      });
      // Must reuse the re-cancelled bracket's id, NOT mint fresh.
      expect(r.subagentId).toBe(SID);
      store.close();
    });

    test("six parallel siblings with same args_hash: each pops a distinct cancelled bracket, none collide", async () => {
      // The review.dot live shape: parent fans out 6 same-args
      // sub-agent calls. All get cancelled by a budget pause. On
      // resume the parent re-emits 6 calls with the same args_hash;
      // each pops a distinct cancelled bracket from the queue.
      const store = freshStore();
      seedParent(store, "parent-cx-4");
      const registry = freshRegistry();
      const ctrl = new AbortController();
      const emit = async (type: EventType, data: Record<string, unknown>) => {
        store.appendObservabilityEvents("parent-cx-4", [{ type, payload: data }]);
      };

      const ARGS_HASH = "ffeeddccbbaa99887766554433221100";
      // Seed 6 distinct cancelled brackets directly via the store.
      // Modelling the original cancellation path through spawn-subagent
      // (sequential or parallel) is unnecessary for what this test
      // pins — the FIFO queue at retry time is what we care about,
      // and using the store directly keeps the setup unambiguous (no
      // possibility of the setup phase itself triggering FIFO pops).
      const cancelledIds: string[] = [];
      for (let i = 0; i < 6; i++) {
        const sid = `sib${i.toString().padStart(2, "0")}aabbccddeeff00112233445566778899`.slice(0, 32);
        cancelledIds.push(sid);
        store.appendObservabilityEvents("parent-cx-4", [
          {
            type: "subagent.start",
            payload: {
              subagent_id: sid,
              parent_node_id: "fanout",
              iteration: 0,
              provider: "anthropic",
              model: "claude-opus-4-7",
              tool_call_id: `toolu_first_${i}`,
              args_hash: ARGS_HASH,
            },
          },
          {
            type: "subagent.end",
            payload: {
              subagent_id: sid,
              status: "cancelled",
              summary_chars: 0,
              total_tool_calls: 0,
              costUsd: 0,
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          },
        ]);
      }
      expect(new Set(cancelledIds).size).toBe(6);

      const makeSpawn = (backend: StubBackend) =>
        makeSpawnSubagent(
          { store, registry, backend, shutdownSignal: ctrl.signal },
          {
            parentRunId: "parent-cx-4",
            parentNodeId: "fanout",
            parentIteration: 0,
            parentSystemPrompt: "P",
            parentSkills: [],
            parentProvider: "anthropic",
            parentModel: "claude-opus-4-7",
            parentEnv: STUB_ENV,
            parentEmit: emit,
          },
        );

      // 6 retries — IN PARALLEL — with same args_hash. Each must pop
      // a DISTINCT cancelled bracket. If the FIFO consumption races
      // (two siblings pick the same id before either emits
      // subagent.resumed), we'd see duplicates here.
      const okBackend = new StubBackend(() => ok({ notes: "" }));
      const retries = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          makeSpawn(okBackend)({
            prompt: "lens",
            tool_call_id: `toolu_retry_${i}`,
            args_hash: ARGS_HASH,
          }),
        ),
      );
      const retriedIds = retries.map((r) => r.subagentId);
      // No duplicates — each retry resumed a distinct cancelled bracket.
      expect(new Set(retriedIds).size).toBe(6);
      // Every retried id corresponds to a prior cancelled id (FIFO,
      // so order matches insertion order: first retry → first cancelled).
      const cancelledSet = new Set(cancelledIds);
      for (const id of retriedIds) expect(cancelledSet.has(id)).toBe(true);
      store.close();
    });
  });
});
