// Checkpoint / resume — PiCodergenBackend survives a daemon restart.
//
// Invariants guarded here:
//
//   1. Each finished agent message lands in `messages` as a full pi-
//      agent-core `AgentMessage` stored as JSON (§I9). No shape loss
//      across a daemon restart.
//   2. The handler-bridge loads prior messages from the store before
//      each backend.run() so a fresh backend instance post-restart
//      sees history via `input.priorMessages` (typed AgentMessage[]).
//      Swarm-internal `role:"system"` rows (SystemPromptMessage) are
//      filtered out — pi-ai carries the system prompt separately.
//   3. Event payloads never carry the message content — only the
//      messages table does — so §I7 (4KB event cap) stays intact even
//      for 8 KB+ assistant turns.

import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
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

function assistantMsg(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic" as never,
    provider: "anthropic" as never,
    model: "stub",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
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
      input.persistMessage?.(assistantMsg(`reply to ${input.prompt}`));
      return ok({ notes: "ok", context_updates: {} });
    },
  };
  return { backend, calls };
}

describe("messages table populates on persistMessage", () => {
  test("AgentMessage round-trips losslessly (text block preserved)", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r1", store, "n1");
    const { backend } = makeInstrumentedBackend();
    await makeCodergenHandler({ node: node({ id: "n1" }), backend }).handler(ctx);

    const msgs = store.getMessages("r1");
    expect(msgs).toHaveLength(1);
    const msg = msgs[0]?.content;
    expect(msg?.role).toBe("assistant");
    expect(msg?.role === "assistant" && msg.content[0]).toMatchObject({ type: "text", text: "reply to hello" });
    store.close();
  });

  test("toolResult preserves tool_use pairing fields", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r2", store, "n1");
    const backend: CodergenBackend = {
      async run(input) {
        input.persistMessage?.({
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "grep",
          content: [{ type: "text", text: "grep output" }],
          isError: false,
          timestamp: 1,
        });
        return ok({ notes: "", context_updates: {} });
      },
    };
    await makeCodergenHandler({ node: node({ id: "n1" }), backend }).handler(ctx);
    const msgs = store.getMessages("r2");
    const msg = msgs[0]?.content;
    expect(msg?.role).toBe("toolResult");
    expect(msg?.role === "toolResult" && msg.toolCallId).toBe("tc1");
    expect(msg?.role === "toolResult" && msg.toolName).toBe("grep");
    expect(msg?.role === "toolResult" && msg.isError).toBe(false);
    store.close();
  });
});

describe("handler-bridge priorMessages hydration", () => {
  test("loads rows from messages table into input.priorMessages", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow("sha", "t", "digraph{}");
    store.enqueueRun({ runId: "r1", workflowSha: "sha" });

    store.appendMessage("r1", {
      content: assistantMsg("earlier"),
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

describe("computeResumeDecision — observational resume flag", () => {
  test("resume + fidelity=full → flag set, fidelity unchanged", () => {
    const r = computeResumeDecision({
      fidelity: "full",
      isFresh: false,
      threadId: "t1",
      externalPriorLen: 3,
      hasInProcessWrite: false,
    });
    expect(r.resumed).toBe(true);
    expect(r.effectiveFidelity).toBe("full");
  });

  test("resume + fidelity=compact → flag set, fidelity unchanged", () => {
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

describe("PiCodergenBackend — shared inProcessWrites across nodes", () => {
  // Regression for the build-feature false-positive resume: `implement`
  // and `verify` on the shared `thread_id="dev"` each run through their
  // own `PiCodergenBackend` instance (one backend per node, per
  // `packages/cli/src/commands/daemon.ts`). Without a shared Set, the
  // second node's fresh backend sees a non-empty prior transcript from
  // the messages table and no in-process write record, so
  // `computeResumeDecision` falsely flags a daemon restart and degrades
  // fidelity=full to summary:high — burning budget with no merged diff.
  test("two backends sharing a Set see each other's writes", () => {
    const shared = new Set<string>();
    const a = new PiCodergenBackend({
      registry: new ToolRegistry(),
      env: new LocalEnvironment({ cwd: process.cwd() }),
      inProcessWrites: shared,
    });
    const b = new PiCodergenBackend({
      registry: new ToolRegistry(),
      env: new LocalEnvironment({ cwd: process.cwd() }),
      inProcessWrites: shared,
    });

    expect(a.hasInProcessWrite("r1", "dev")).toBe(false);
    expect(b.hasInProcessWrite("r1", "dev")).toBe(false);

    // Simulate the `implement` backend finishing a run on (r1, "dev").
    shared.add("r1::dev");

    // The `verify` backend — constructed fresh but wired to the same
    // shared Set — now sees the write and must NOT detect a resume.
    expect(b.hasInProcessWrite("r1", "dev")).toBe(true);
    const decision = computeResumeDecision({
      fidelity: "full",
      isFresh: false,
      threadId: "dev",
      externalPriorLen: 5,
      hasInProcessWrite: b.hasInProcessWrite("r1", "dev"),
    });
    expect(decision.resumed).toBe(false);
    expect(decision.effectiveFidelity).toBe("full");
  });

  test("two backends with separate Sets flag resumed=true but don't degrade", () => {
    // Without a shared Set the second backend has no record of the
    // first's writes and flags resume=true. That signal is now purely
    // observational — effectiveFidelity stays whatever the node asked
    // for.
    const a = new PiCodergenBackend({
      registry: new ToolRegistry(),
      env: new LocalEnvironment({ cwd: process.cwd() }),
    });
    const b = new PiCodergenBackend({
      registry: new ToolRegistry(),
      env: new LocalEnvironment({ cwd: process.cwd() }),
    });

    expect(b.hasInProcessWrite("r1", "dev")).toBe(false);
    const decision = computeResumeDecision({
      fidelity: "full",
      isFresh: false,
      threadId: "dev",
      externalPriorLen: 5,
      hasInProcessWrite: b.hasInProcessWrite("r1", "dev"),
    });
    expect(decision.resumed).toBe(true);
    expect(decision.effectiveFidelity).toBe("full");
    void a;
  });

  test("forgetRun only clears the target run's keys from the shared Set", () => {
    const shared = new Set<string>();
    const backend = new PiCodergenBackend({
      registry: new ToolRegistry(),
      env: new LocalEnvironment({ cwd: process.cwd() }),
      inProcessWrites: shared,
    });
    shared.add("r1::dev");
    shared.add("r2::dev");
    shared.add("r1::review");
    backend.forgetRun("r1");
    expect(shared.has("r1::dev")).toBe(false);
    expect(shared.has("r1::review")).toBe(false);
    expect(shared.has("r2::dev")).toBe(true);
  });
});

describe("daemon-boot inProcessWrites reconstruction", () => {
  test("seeded Set from listThreadsWithMessages() prevents resume=true on known threads", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow("sha", "t", "digraph{}");
    store.enqueueRun({ runId: "r1", workflowSha: "sha" });
    store.appendMessage("r1", {
      content: assistantMsg("prior turn"),
      nodeId: "dev",
      iteration: 0,
    });

    const seeded = new Set<string>();
    for (const pair of store.listThreadsWithMessages()) {
      seeded.add(`${pair.runId}::${pair.threadId}`);
    }

    expect(seeded.has("r1::dev")).toBe(true);
    const decision = computeResumeDecision({
      fidelity: "full",
      isFresh: false,
      threadId: "dev",
      externalPriorLen: 1,
      hasInProcessWrite: seeded.has("r1::dev"),
    });
    expect(decision.resumed).toBe(false);
    expect(decision.effectiveFidelity).toBe("full");
    store.close();
  });

  test("reconstruction matches in-process Set after one dispatch", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const shared = new Set<string>();
    const backend = new PiCodergenBackend({
      registry: new ToolRegistry(),
      env: new LocalEnvironment({ cwd: process.cwd() }),
      inProcessWrites: shared,
    });
    const ctx = await ctxFor("r1", store, "dev");
    const inner: CodergenBackend = {
      async run(input) {
        input.persistMessage?.(assistantMsg("r1 dev"));
        return ok({ notes: "", context_updates: {} });
      },
    };
    await makeCodergenHandler({ node: node({ id: "dev" }), backend: inner }).handler(ctx);

    const live = new Set<string>(shared);
    live.add("r1::dev");

    const rebuilt = new Set<string>();
    for (const pair of store.listThreadsWithMessages()) {
      rebuilt.add(`${pair.runId}::${pair.threadId}`);
    }

    expect(rebuilt).toEqual(live);
    void backend;
    store.close();
  });
});

describe("event payload cap (§I7) survives unbounded message content", () => {
  test("8KB assistant content lands in messages table, not event payload", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r5", store, "n1");
    const huge = "x".repeat(8192);
    const backend: CodergenBackend = {
      async run(input) {
        input.persistMessage?.(assistantMsg(huge));
        await input.emit?.("agent.message_end", { role: "assistant" });
        return ok({ notes: "", context_updates: {} });
      },
    };
    await makeCodergenHandler({ node: node({ id: "n1" }), backend }).handler(ctx);

    const msgs = store.getMessages("r5");
    const msg = msgs[0]?.content;
    const text = msg?.role === "assistant" ? ((msg.content[0] as { text: string } | undefined)?.text ?? "") : "";
    expect(text.length).toBe(8192);

    for (const ev of store.getEvents("r5")) {
      const size = JSON.stringify(ev.payload).length;
      expect(size).toBeLessThan(4096);
    }
    store.close();
  });
});
