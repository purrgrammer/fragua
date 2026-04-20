// Checkpoint / resume — PiCodergenBackend survives a daemon restart.
//
// Invariants guarded here:
//
//   1. Each finished agent message lands in `messages` with flattened
//      `content` (UI plaintext) AND structured `payload_json`
//      (AgentMessage JSON). payload_json is lossless — required to
//      rehydrate tool_use blocks + tool_result shapes on resume.
//   2. The handler-bridge loads prior messages from the store before
//      each backend.run() so a fresh backend instance post-restart
//      sees history as `input.priorMessages`.
//   3. `fidelity=full` survives a daemon restart: the store carries
//      the transcript across process boundaries and the second
//      backend instance sees it via `priorMessages`.
//   4. pi-agent-core roles (`toolResult`) map onto swarm's MessageRole
//      (`tool`) so persistence round-trips cleanly.
//   5. Event payloads never carry the message content — only the
//      messages table does — so §I7 (4KB event cap) stays intact even
//      for 8 KB+ assistant turns.
//   6. v1 → v3 schema migration adds the payload_json column without
//      dropping existing rows or other tables.

import { describe, expect, test } from "bun:test";
import type { CodergenBackend, CodergenInput, Node } from "@swarm/core";
import { ok } from "@swarm/core";
import * as handler from "@swarm/core/handler";
import { SqliteStore } from "@swarm/store";
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
      const msg = {
        role: "assistant",
        content: [{ type: "text", text: `reply to ${input.prompt}` }],
        timestamp: Date.now(),
      };
      input.persistMessage?.("assistant", `reply to ${input.prompt}`, JSON.stringify(msg));
      return ok({ notes: "ok", context_updates: {} });
    },
  };
  return { backend, calls };
}

describe("messages table populates on persistMessage", () => {
  test("content + payloadJson round-trip", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r1", store, "n1");
    const { backend } = makeInstrumentedBackend();
    await makeCodergenHandler({ node: node({ id: "n1" }), backend }).handler(ctx);

    const msgs = store.getMessages("r1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("assistant");
    expect(msgs[0]?.content).toBe("reply to hello");
    expect(msgs[0]?.payloadJson).toBeDefined();
    const parsed = JSON.parse(msgs[0]!.payloadJson!);
    expect(parsed.role).toBe("assistant");
    expect(parsed.content[0].text).toBe("reply to hello");
    store.close();
  });

  test("tool role maps through (toolResult → tool)", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r2", store, "n1");
    const backend: CodergenBackend = {
      async run(input) {
        input.persistMessage?.("tool", "grep output", JSON.stringify({ role: "toolResult", content: "grep output" }));
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
      payloadJson: JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "earlier" }],
        timestamp: 1,
      }),
    });

    const { backend, calls } = makeInstrumentedBackend();
    const ctx = await ctxFor("r1", store, "n1");
    await makeCodergenHandler({ node: node({ id: "n1" }), backend }).handler(ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.priorMessagesLen).toBe(1);
    store.close();
  });

  test("no prior messages → priorMessages is empty (not undefined lengths aside)", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const ctx = await ctxFor("r3", store, "n1");
    const { backend, calls } = makeInstrumentedBackend();
    await makeCodergenHandler({ node: node({ id: "n1" }), backend }).handler(ctx);
    expect(calls[0]?.priorMessagesLen).toBe(0);
    expect(calls[0]?.fidelity).toBe("full");
    store.close();
  });

  test("fallback: synthesises AgentMessage from content when payloadJson is null (legacy rows)", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow("sha", "t", "digraph{}");
    store.enqueueRun({ runId: "r4", workflowSha: "sha" });
    store.appendMessage("r4", {
      role: "assistant",
      content: "legacy row without payload_json",
      nodeId: "n1",
      iteration: 0,
      payloadJson: null,
    });
    const { backend, calls } = makeInstrumentedBackend();
    await makeCodergenHandler({ node: node({ id: "n1" }), backend }).handler(await ctxFor("r4", store, "n1"));
    expect(calls[0]?.priorMessagesLen).toBe(1);
    store.close();
  });
});

describe("PiCodergenBackend resume surface", () => {
  test("hasInProcessWrite starts false for every (run, thread)", () => {
    const { LocalEnvironment, ToolRegistry } = require("@swarm/workspace") as typeof import("@swarm/workspace");
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
        input.persistMessage?.(
          "assistant",
          huge,
          JSON.stringify({ role: "assistant", content: [{ type: "text", text: huge }], timestamp: 1 }),
        );
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

describe("v1 → v3 schema migration", () => {
  test("existing v1 DB picks up title + payload_json on migrate", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Database } = await import("bun:sqlite");

    const dir = mkdtempSync(join(tmpdir(), "swarm-migrate-"));
    const path = join(dir, "swarm.db");

    // Hand-build a v1 DB (no title on run_state, no payload_json on messages).
    const db = new Database(path);
    db.exec(`PRAGMA journal_mode = WAL;`);
    db.exec(`
      CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL) STRICT;
      INSERT INTO schema_version VALUES (1, 1);
      CREATE TABLE workflows (sha TEXT PRIMARY KEY, name TEXT NOT NULL, dot_source TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE run_state (
        run_id TEXT PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('queued','running','paused_hitl','completed','cancelled','halted','quarantined')),
        current_node TEXT, workflow_sha TEXT NOT NULL REFERENCES workflows(sha), schema_version INTEGER NOT NULL,
        routing TEXT NOT NULL CHECK (length(routing) < 8192), metrics TEXT NOT NULL, next_seq INTEGER NOT NULL DEFAULT 1,
        last_applied_seq INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0,
        enqueued_at INTEGER NOT NULL, ready_at INTEGER NOT NULL, node_started_at INTEGER, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE events (run_id TEXT NOT NULL REFERENCES run_state(run_id) ON DELETE CASCADE, seq INTEGER NOT NULL, type TEXT NOT NULL, writer TEXT NOT NULL CHECK (writer IN ('daemon','web')), payload TEXT NOT NULL CHECK (length(payload) < 4096), ts INTEGER NOT NULL, PRIMARY KEY (run_id, seq)) STRICT, WITHOUT ROWID;
      CREATE TABLE messages (run_id TEXT NOT NULL REFERENCES run_state(run_id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')), content TEXT NOT NULL, node_id TEXT, iteration INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (run_id, ordinal)) STRICT, WITHOUT ROWID;
      CREATE TABLE blobs (sha256 TEXT NOT NULL UNIQUE, content BLOB NOT NULL, size_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE artifacts (run_id TEXT NOT NULL REFERENCES run_state(run_id) ON DELETE CASCADE, node_id TEXT NOT NULL, iteration INTEGER NOT NULL DEFAULT 0, key TEXT NOT NULL, blob_sha TEXT NOT NULL REFERENCES blobs(sha256), mime TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (run_id, node_id, iteration, key)) STRICT, WITHOUT ROWID;
      CREATE TABLE daemon_lock (id INTEGER PRIMARY KEY CHECK (id=1), pid INTEGER NOT NULL, hostname TEXT NOT NULL, started_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL) STRICT;
    `);
    // Insert a legacy run + message.
    db.query(`INSERT INTO workflows (sha, name, dot_source, created_at) VALUES ('s', 'w', 'digraph{}', 1)`).run();
    db.query(
      `INSERT INTO run_state
       (run_id, version, status, current_node, workflow_sha, schema_version,
        routing, metrics, next_seq, last_applied_seq, priority,
        enqueued_at, ready_at, node_started_at, updated_at)
       VALUES ('r-legacy', 1, 'queued', NULL, 's', 1, '{}', '{"totalTokens":0,"totalCostUsd":0,"loopCounts":{},"models":{}}', 1, 0, 0, 1, 1, NULL, 1)`,
    ).run();
    db.query(
      `INSERT INTO messages (run_id, ordinal, role, content, node_id, iteration) VALUES ('r-legacy', 1, 'assistant', 'legacy text', 'n1', 0)`,
    ).run();
    db.close();

    // Open with the current-code SqliteStore → migrate runs.
    const store = new SqliteStore({ path });
    const msgs = store.getMessages("r-legacy");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.content).toBe("legacy text");
    expect(msgs[0]?.payloadJson).toBeNull();

    // New appends carry payload_json, old rows keep null.
    store.appendMessage("r-legacy", {
      role: "user",
      content: "new",
      nodeId: "n1",
      iteration: 0,
      payloadJson: JSON.stringify({ role: "user", content: "new" }),
    });
    const msgs2 = store.getMessages("r-legacy");
    expect(msgs2).toHaveLength(2);
    expect(msgs2[1]?.payloadJson).toBeDefined();

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
