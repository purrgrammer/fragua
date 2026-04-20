// Checkpoint / resume — PiCodergenBackend survives a daemon restart.
//
// Invariants guarded here:
//
//   1. Each finished agent message lands in `messages` with flattened
//      plaintext `content`. Resume always degrades fidelity=full →
//      summary:high (SPEC §3.6), so plaintext is sufficient — the
//      structured AgentMessage shape never needs to cross a daemon
//      restart.
//   2. The handler-bridge loads prior messages from the store before
//      each backend.run() so a fresh backend instance post-restart
//      sees history as `input.priorMessages` (synthesised AgentMessages
//      from plaintext).
//   3. pi-agent-core roles (`toolResult`) map onto swarm's MessageRole
//      (`tool`) so persistence round-trips cleanly.
//   4. Event payloads never carry the message content — only the
//      messages table does — so §I7 (4KB event cap) stays intact even
//      for 8 KB+ assistant turns.

import { describe, expect, test } from "bun:test";
import type { CodergenBackend, CodergenInput, Node } from "@swarm/core";
import { ok } from "@swarm/core";
import * as handler from "@swarm/core/handler";
import { SqliteStore } from "@swarm/store";
import { LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { computeResumeDecision, PiCodergenBackend } from "../src/backend.ts";
import { makeCodergenHandler } from "../src/handler-bridge.ts";

function node(overrides: Partial<Node> = {}): Node {
  return {
    id: overrides.id ?? "n1",
    attrs: {
      shape: "box",
      prompt: "hello",
      fidelity: "full",
      thread_id: overrides.id ?? "n1",
      ...(overrides.attrs ?? {}),
    },
  } as Node;
}

async function ctxFor(runId: string, store: SqliteStore, nodeId: string): Promise<handler.HandlerContext> {
  store.saveWorkflow("sha", "t", "digraph{}");
  try {
    store.enqueueRun({ runId, workflowSha: "sha" });
  } catch {
    // ignore — repeat enqueue attempted by same-runId cross-turn tests
  }
  const ac = new AbortController();
  const tools = new handler.InMemoryToolRegistry();
  return handler.buildHandlerContext({
    runId,
    nodeId,
    iteration: 0,
    signal: ac.signal,
    routing: {},
    store,
    llm: handler.makeLlmClient({
      signal: ac.signal,
      call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }),
    }),
    http: handler.makeHttpClient({ signal: ac.signal }),
    tools,
    args: {},
    recorder: {
      recordIntent: () => {},
      recordDone: () => {},
      recordFailed: () => {},
    },
  });
}

function makeInstrumentedBackend(): {
  backend: CodergenBackend;
  calls: Array<Pick<CodergenInput, "run_id" | "thread_id" | "fidelity"> & { priorMessagesLen: number }>;
} {
  const calls: Array<Pick<CodergenInput, "run_id" | "thread_id" | "fidelity"> & { priorMessagesLen: number }> = [];
  const backend: CodergenBackend = {
    async run(input) {
      calls.push({
        run_id: input.run_id,
        thread_id: input.thread_id,
        fidelity: input.fidelity,
        priorMessagesLen: input.priorMessages?.length ?? 0,
      });
      input.persistMessage?.("assistant", `reply to ${input.prompt}`);
      return ok({ notes: "ok", context_updates: {} });
    },
  };
  return { backend, calls };
}

describe("messages table populates on persistMessage", () => {
  test("plaintext content round-trip", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r1", store, "n1");
    const { backend } = makeInstrumentedBackend();
    await makeCodergenHandler({ node: node({ id: "n1" }), backend }).handler(ctx);

    const msgs = store.getMessages("r1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("assistant");
    expect(msgs[0]?.content).toBe("reply to hello");
    store.close();
  });

  test("tool role maps through (toolResult → tool)", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r2", store, "n1");
    const backend: CodergenBackend = {
      async run(input) {
        input.persistMessage?.("tool", "grep output");
        return ok({ notes: "", context_updates: {} });
      },
    };
    await makeCodergenHandler({ node: node({ id: "n1" }), backend }).handler(ctx);
    const msgs = store.getMessages("r2");
    expect(msgs[0]?.role).toBe("tool");
    expect(msgs[0]?.content).toBe("grep output");
    store.close();
  });
});

describe("handler-bridge priorMessages hydration", () => {
  test("loads rows from messages table into input.priorMessages", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow("sha", "t", "digraph{}");
    store.enqueueRun({ runId: "r1", workflowSha: "sha" });

    store.appendMessage("r1", {
      role: "assistant",
      content: "earlier",
      nodeId: "n1",
      iteration: 0,
    });

    const { backend, calls } = makeInstrumentedBackend();
    const ctx = await ctxFor("r1", store, "n1");
    await makeCodergenHandler({ node: node({ id: "n1" }), backend }).handler(ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.priorMessagesLen).toBe(1);
    store.close();
  });

  test("no prior messages → priorMessages is empty, fidelity preserved", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r3", store, "n1");
    const { backend, calls } = makeInstrumentedBackend();
    await makeCodergenHandler({ node: node({ id: "n1" }), backend }).handler(ctx);
    expect(calls[0]?.priorMessagesLen).toBe(0);
    expect(calls[0]?.fidelity).toBe("full");
    store.close();
  });
});

describe("PiCodergenBackend resume surface", () => {
  test("hasInProcessWrite starts false for every (run, thread)", () => {
    const b = new PiCodergenBackend({
      registry: new ToolRegistry(),
      env: new LocalEnvironment({ cwd: process.cwd() }),
    });
    expect(b.hasInProcessWrite("r1", "t1")).toBe(false);
    expect(b.hasInProcessWrite("r2", "t1")).toBe(false);
    expect(b.hasInProcessWrite("r1", "t2")).toBe(false);
  });
});

describe("computeResumeDecision — pure §3.6 logic", () => {
  test("resume + fidelity=full → degrade to summary:high", () => {
    const r = computeResumeDecision({
      fidelity: "full",
      isFresh: false,
      threadId: "t1",
      externalPriorLen: 3,
      hasInProcessWrite: false,
    });
    expect(r.resumed).toBe(true);
    expect(r.effectiveFidelity).toBe("summary:high");
  });

  test("resume + fidelity=compact → stays compact (non-full modes don't degrade)", () => {
    const r = computeResumeDecision({
      fidelity: "compact",
      isFresh: false,
      threadId: "t1",
      externalPriorLen: 3,
      hasInProcessWrite: false,
    });
    expect(r.resumed).toBe(true);
    expect(r.effectiveFidelity).toBe("compact");
  });

  test("in-process write present → NOT a resume (still alive in this process)", () => {
    const r = computeResumeDecision({
      fidelity: "full",
      isFresh: false,
      threadId: "t1",
      externalPriorLen: 3,
      hasInProcessWrite: true,
    });
    expect(r.resumed).toBe(false);
    expect(r.effectiveFidelity).toBe("full");
  });

  test("empty prior → NOT a resume (truly fresh start)", () => {
    const r = computeResumeDecision({
      fidelity: "full",
      isFresh: false,
      threadId: "t1",
      externalPriorLen: 0,
      hasInProcessWrite: false,
    });
    expect(r.resumed).toBe(false);
    expect(r.effectiveFidelity).toBe("full");
  });

  test("caller did not supply priorMessages (-1) → NOT a resume", () => {
    const r = computeResumeDecision({
      fidelity: "full",
      isFresh: false,
      threadId: "t1",
      externalPriorLen: -1,
      hasInProcessWrite: false,
    });
    expect(r.resumed).toBe(false);
    expect(r.effectiveFidelity).toBe("full");
  });

  test("no threadId → never a resume (nothing to key on)", () => {
    const r = computeResumeDecision({
      fidelity: "full",
      isFresh: false,
      threadId: undefined,
      externalPriorLen: 5,
      hasInProcessWrite: false,
    });
    expect(r.resumed).toBe(false);
    expect(r.effectiveFidelity).toBe("full");
  });

  test("isFresh=true beats everything (explicit opt-out)", () => {
    const r = computeResumeDecision({
      fidelity: "full",
      isFresh: true,
      threadId: "t1",
      externalPriorLen: 5,
      hasInProcessWrite: false,
    });
    expect(r.resumed).toBe(false);
    expect(r.effectiveFidelity).toBe("full");
  });
});

describe("event payload cap (§I7) survives unbounded message content", () => {
  test("8KB assistant content lands in messages table, not event payload", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r5", store, "n1");
    const huge = "x".repeat(8192);
    const backend: CodergenBackend = {
      async run(input) {
        input.persistMessage?.("assistant", huge);
        await input.emit?.("agent.message_end", { role: "assistant" });
        return ok({ notes: "", context_updates: {} });
      },
    };
    await makeCodergenHandler({ node: node({ id: "n1" }), backend }).handler(ctx);

    const msgs = store.getMessages("r5");
    expect(msgs[0]?.content.length).toBe(8192);

    for (const ev of store.getEvents("r5")) {
      const size = JSON.stringify(ev.payload).length;
      expect(size).toBeLessThan(4096);
    }
    store.close();
  });
});
