// Sub-agent inline-codergen behaviour: a parent's `agent` tool call
// drives a fresh codergen call against the same parent run, with all
// observability events forwarded onto the parent's stream stamped with
// a `subagent_id`. No child run, no separate stream, no `fact.run_*`
// for the sub-agent.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
});
