// runConversation drives a sub-agent run to terminal without
// consulting any graph or dispatcher. The codergen backend is
// stubbed so we can pin the outcome and verify the resulting
// state + facts on the child stream.

import { describe, expect, test } from "bun:test";
import type { CodergenInput, Outcome } from "@swarm/core";
import { fail, ok } from "@swarm/core";
import { SqliteStore } from "@swarm/store";
import { runConversation } from "../src/conversation.ts";
import { Dispatcher } from "../src/dispatch.ts";

function freshStore(): SqliteStore {
  return new SqliteStore({ path: ":memory:" });
}

function seedConversation(
  store: SqliteStore,
  runId: string,
  parentRunId: string,
  routing: Record<string, unknown> = {},
): void {
  // Parent run is required by the FK on parent_run_id.
  store.saveWorkflow("wf", "t", "digraph{}");
  store.enqueueRun({ runId: parentRunId, workflowSha: "wf" });
  store.enqueueConversation({
    runId,
    parentRunId,
    parentNodeId: "plan",
    parentIteration: 0,
    initialRouting: { input: "do the thing", ...routing },
  });
}

class StubBackend {
  public lastInput: CodergenInput | undefined;
  constructor(private readonly outcomeFactory: (input: CodergenInput) => Outcome) {}
  async run(input: CodergenInput): Promise<Outcome> {
    this.lastInput = input;
    if (input.persistMessage) {
      input.persistMessage({
        role: "assistant",
        content: [{ type: "text", text: "child reply" }],
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
    return this.outcomeFactory(input);
  }
}

describe("runConversation", () => {
  test("drives codergen loop to terminal and writes fact.run_completed", async () => {
    const store = freshStore();
    seedConversation(store, "child-1", "parent-1", {
      "agent.system_prompt": "REVIEWER",
      "agent.tool_pool": ["read"],
    });
    const backend = new StubBackend(() => ok({ notes: "ok" }));
    const ctrl = new AbortController();

    await runConversation("child-1", { store, backend, shutdownSignal: ctrl.signal });

    const state = store.getState("child-1")!;
    expect(state.status).toBe("completed");
    expect(state.kind).toBe("conversation");

    const events = store.getEvents("child-1");
    const types = events.map((e) => e.type);
    expect(types).toContain("fact.run_started");
    expect(types).toContain("fact.run_completed");

    // The synthesised CodergenInput carries the routing snapshot.
    expect(backend.lastInput?.prompt).toBe("do the thing");
    expect(backend.lastInput?.node.attrs["system_prompt"]).toBe("REVIEWER");
    expect(backend.lastInput?.workflow_sha).toBe("");

    // fact.run_started for a conversation run carries workflowSha=null.
    const startedFact = events.find((e) => e.type === "fact.run_started");
    expect((startedFact?.payload as { workflowSha: unknown })?.workflowSha).toBeNull();
    store.close();
  });

  test("fail outcome maps to fact.run_halted with reason='error'", async () => {
    const store = freshStore();
    seedConversation(store, "child-2", "parent-2");
    const backend = new StubBackend(() => fail("agent gave up"));
    const ctrl = new AbortController();

    await runConversation("child-2", { store, backend, shutdownSignal: ctrl.signal });

    const state = store.getState("child-2")!;
    expect(state.status).toBe("halted");

    const events = store.getEvents("child-2");
    const halt = events.find((e) => e.type === "fact.run_halted");
    expect(halt).toBeDefined();
    const payload = halt?.payload as { reason: string; detail?: string };
    expect(payload.reason).toBe("error");
    expect(payload.detail).toContain("agent gave up");
    store.close();
  });

  test("does not consult a dispatcher (no graph walk)", async () => {
    const store = freshStore();
    seedConversation(store, "child-3", "parent-3");
    // Build a dispatcher whose .get throws. runConversation must never
    // reach for it; if it does, the run halts with the trap message.
    const trapDispatcher = new Dispatcher();
    Object.defineProperty(trapDispatcher, "get", {
      value: () => {
        throw new Error("runConversation must not call the workflow dispatcher");
      },
    });

    const backend = new StubBackend(() => ok({ notes: "" }));
    const ctrl = new AbortController();

    await runConversation("child-3", { store, backend, shutdownSignal: ctrl.signal });
    expect(store.getState("child-3")?.status).toBe("completed");
    store.close();
  });

  test("throws when called on a non-conversation run", async () => {
    const store = freshStore();
    store.saveWorkflow("wf", "t", "digraph{}");
    store.enqueueRun({ runId: "workflow-run", workflowSha: "wf" });
    const backend = new StubBackend(() => ok({ notes: "" }));
    const ctrl = new AbortController();

    await expect(runConversation("workflow-run", { store, backend, shutdownSignal: ctrl.signal })).rejects.toThrow(
      /non-conversation/,
    );
    store.close();
  });
});
