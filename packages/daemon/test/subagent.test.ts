// E2E for the `agent` tool seam: parent codergen iteration calls
// `spawnSubagent` (the closure built by `makeSpawnSubagent`), which
// enqueues a conversation child, drives it via `runConversation`, and
// returns the summary. The codergen backend is stubbed so we can pin
// the child's outcome and inspect the resulting state + facts.

import { describe, expect, test } from "bun:test";
import type { CodergenInput, Outcome } from "@swarm/core";
import { ok } from "@swarm/core";
import { SqliteStore } from "@swarm/store";
import type { Skill, SubagentSpec } from "@swarm/workspace";
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

describe("makeSpawnSubagent", () => {
  test("parent calls agent → child conversation runs → returns summary", async () => {
    const store = freshStore();
    seedParent(store, "parent-1");
    const registry = freshRegistry();
    const backend = new StubBackend(() => ok({ notes: "" }));
    const ctrl = new AbortController();

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-1",
        parentNodeId: "plan",
        parentIteration: 2,
        parentSystemPrompt: "PARENT BASE PROMPT",
        parentSkills: [],
      },
    );

    const result = await spawn({ prompt: "do the thing", description: "step 1" });

    expect(result.summary).toBe("child summary text");
    expect(result.status).toBe("completed");
    expect(result.childRunId).toMatch(/^conv-/);

    // Child row carries parent linkage + kind=conversation.
    const child = store.getState(result.childRunId)!;
    expect(child.kind).toBe("conversation");
    expect(child.parentRunId).toBe("parent-1");
    expect(child.parentNodeId).toBe("plan");
    expect(child.parentIteration).toBe(2);
    expect(child.workflowSha).toBeNull();

    // Parent stream carries fact.subagent.spawned then .completed.
    const parentEvents = store.getEvents("parent-1");
    const subagentTypes = parentEvents.map((e) => e.type).filter((t) => t.startsWith("fact.subagent."));
    expect(subagentTypes).toEqual(["fact.subagent.spawned", "fact.subagent.completed"]);

    const spawned = parentEvents.find((e) => e.type === "fact.subagent.spawned")!;
    const spawnedPayload = spawned.payload as {
      parent_node_id: string;
      iteration: number;
      child_run_id: string;
      label?: string;
    };
    expect(spawnedPayload.parent_node_id).toBe("plan");
    expect(spawnedPayload.iteration).toBe(2);
    expect(spawnedPayload.child_run_id).toBe(result.childRunId);
    expect(spawnedPayload.label).toBe("step 1");

    const completed = parentEvents.find((e) => e.type === "fact.subagent.completed")!;
    const completedPayload = completed.payload as {
      child_run_id: string;
      status: string;
      summary_chars: number;
      total_tool_calls: number;
    };
    expect(completedPayload.child_run_id).toBe(result.childRunId);
    expect(completedPayload.status).toBe("completed");
    expect(completedPayload.summary_chars).toBe("child summary text".length);
    store.close();
  });

  test("agent tool is structurally absent from child's pool even when parent allowed it", async () => {
    const store = freshStore();
    seedParent(store, "parent-2");
    const registry = freshRegistry();
    let observedChildPool: string[] | undefined;
    const backend = new StubBackend((input) => {
      observedChildPool = (input.node.attrs["allowed_tools"] as string[] | undefined)?.slice();
      return ok({ notes: "" });
    });
    const ctrl = new AbortController();

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-2",
        parentNodeId: "plan",
        parentIteration: 0,
        parentSystemPrompt: "P",
        parentSkills: [],
        parentAllowedTools: ["read", "write", "agent"],
      },
    );

    // Even though the spec explicitly requests `agent`, the stripper
    // pulls it out before the child's pool is materialised.
    await spawn({ prompt: "x", allowed_tools: ["read", "agent"] });

    expect(observedChildPool).toBeDefined();
    expect(observedChildPool).not.toContain("agent");
    expect(observedChildPool).toContain("read");
    store.close();
  });

  test("parent cancellation propagates to child via intent.cancel_requested", async () => {
    const store = freshStore();
    seedParent(store, "parent-3");
    const registry = freshRegistry();

    // Backend resolves immediately; we trip the parent's signal BEFORE
    // calling spawn so the abort listener fires synchronously and the
    // child sees an intent.cancel_requested on its stream.
    const backend = new StubBackend(() => ok({ notes: "" }));
    const ctrl = new AbortController();
    const parentSignal = new AbortController();

    const spawn = makeSpawnSubagent(
      { store, registry, backend, shutdownSignal: ctrl.signal },
      {
        parentRunId: "parent-3",
        parentNodeId: "plan",
        parentIteration: 0,
        parentSystemPrompt: "P",
        parentSkills: [],
      },
    );

    parentSignal.abort();
    const spec: SubagentSpec = { prompt: "x", signal: parentSignal.signal };
    const result = await spawn(spec);

    // The cancel intent landed on the child's stream as a side-effect
    // of the abort listener. Whether it influenced the terminal state
    // depends on timing (the stub backend returns ok), but the audit
    // trail is what we care about for the propagation contract.
    const childIntents = store.getEvents(result.childRunId).filter((e) => e.type === "intent.cancel_requested");
    expect(childIntents).toHaveLength(1);
    const payload = childIntents[0]?.payload as { reason: string };
    expect(payload.reason).toBe("parent cancelled");
    store.close();
  });

  test("filtered skills land on the child's catalog and routing snapshot", async () => {
    const store = freshStore();
    seedParent(store, "parent-4");
    const registry = freshRegistry();
    const backend = new StubBackend(() => ok({ notes: "" }));
    const ctrl = new AbortController();

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
      },
    );

    const result = await spawn({ prompt: "x", skills: ["design"] });
    const child = store.getState(result.childRunId)!;
    expect(child.routing["agent.skills"]).toEqual(["design"]);
    store.close();
  });
});
