import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { BlobFS } from "../src/blob-fs.ts";
import {
  ArtifactTooLargeError,
  ConcurrencyError,
  CURRENT_SCHEMA_VERSION,
  type FactEvent,
  type IntentEvent,
  MAX_BLOB_BYTES,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_MESSAGE_CONTENT_BYTES,
  MAX_ROUTING_BYTES,
  MessageTooLargeError,
  PayloadTooLargeError,
} from "../src/index.ts";
import { freshStore, nextId, seedRun, seedWorkflow } from "./helpers.ts";

describe("SqliteStore — lifecycle", () => {
  test("enqueueRun seeds a queued projection and an intent event", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    const runId = nextId();
    store.enqueueRun({ runId, workflowSha: sha, priority: 3 });

    const state = store.getState(runId);
    expect(state).not.toBeNull();
    expect(state!.status).toBe("queued");
    expect(state!.priority).toBe(3);
    expect(state!.version).toBe(1);
    expect(state!.nextSeq).toBe(2);

    const events = store.getEvents(runId);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("intent.run_enqueued");
    expect(events[0]!.writer).toBe("client");

    store.close();
  });

  test("unknown workflow rejects enqueue", async () => {
    const store = freshStore();
    expect(() => store.enqueueRun({ runId: "r1", workflowSha: "missing" })).toThrow(/unknown workflow/);
    store.close();
  });

  test("claimNextRun moves queued → running atomically and respects concurrency cap", async () => {
    const store = freshStore();
    const r1 = await seedRun(store);
    const r2 = await seedRun(store);
    const r3 = await seedRun(store);

    const first = store.claimNextRun(2);
    const second = store.claimNextRun(2);
    const third = store.claimNextRun(2);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).toBeNull();
    expect(new Set([first!.runId, second!.runId])).toEqual(new Set([r1, r2]));
    expect(store.getState(r3)!.status).toBe("queued");
    store.close();
  });

  test("claim order respects priority DESC then ready_at ASC", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    store.enqueueRun({ runId: "low", workflowSha: sha, priority: 1 });
    store.enqueueRun({ runId: "high1", workflowSha: sha, priority: 10 });
    store.enqueueRun({ runId: "high2", workflowSha: sha, priority: 10 });
    expect(store.claimNextRun(10)!.runId).toBe("high1");
    expect(store.claimNextRun(10)!.runId).toBe("high2");
    expect(store.claimNextRun(10)!.runId).toBe("low");
    store.close();
  });
});

describe("SqliteStore — appendFact", () => {
  test("writes events and bumps version; OCC blocks stale writers", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const state = store.getState(runId)!;

    const fact: FactEvent = {
      type: "fact.run_started",
      payload: {
        workflowSha: state.workflowSha,
        contractVersion: state.contractVersion,
        startNode: "a",
      },
    };
    const result = store.appendFact(runId, [fact], state.version);
    expect(result.committed).toBe(true);
    expect(result.newVersion).toBe(state.version + 1);

    expect(() => store.appendFact(runId, [fact], state.version)).toThrow(ConcurrencyError);
    store.close();
  });

  test("returns the post-commit run_state projection (lets a caller skip a redundant getState)", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const state = store.getState(runId)!;
    const result = store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: state.workflowSha, contractVersion: state.contractVersion, startNode: "a" },
        },
      ],
      state.version,
    );
    const fresh = store.getState(runId)!;
    // The folded post-commit projection rides the result — matches a fresh read.
    expect(result.state?.version).toBe(result.newVersion);
    expect(result.state?.version).toBe(fresh.version);
    expect(result.state?.status).toBe("running");
    expect(result.state?.currentNode).toBe("a");
    store.close();
  });

  test("fact.node_completed updates totals and per-model breakdown", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const s0 = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: {
            workflowSha: s0.workflowSha,
            contractVersion: s0.contractVersion,
            startNode: "a",
          },
        },
      ],
      s0.version,
    );

    const s1 = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.node_completed",
          payload: {
            nodeId: "a",
            iteration: 0,
            tokens: 100,
            costUsd: 0.02,
            modelName: "gemini-1.5-pro",
            nextNode: "b",
          },
        },
        {
          type: "fact.node_completed",
          payload: {
            nodeId: "b",
            iteration: 0,
            tokens: 50,
            costUsd: 0.005,
            modelName: "gemini-1.5-flash",
            nextNode: "c",
          },
        },
      ],
      s1.version,
    );

    const s2 = store.getState(runId)!;
    expect(s2.metrics.billedTokens).toBe(150);
    expect(s2.metrics.totalCostUsd).toBeCloseTo(0.025, 6);
    expect(s2.metrics.models["gemini-1.5-pro"]).toEqual({
      tokens: 100,
      costUsd: 0.02,
    });
    expect(s2.metrics.models["gemini-1.5-flash"]).toEqual({
      tokens: 50,
      costUsd: 0.005,
    });

    // generated columns reflect the metrics JSON
    const row = (store as unknown as { db: import("bun:sqlite").Database }).db
      .query<{ total_cost_usd: number; billed_tokens: number }, [string]>(
        "SELECT total_cost_usd, billed_tokens FROM run_state WHERE run_id = ?",
      )
      .get(runId)!;
    expect(row.billed_tokens).toBe(150);
    expect(row.total_cost_usd).toBeCloseTo(0.025, 6);

    store.close();
  });

  test("fact.node_completed accumulates the four-bucket cost split into metrics", async () => {
    // Pin the cost-split projection so the analytics SpendChart can sum
    // per-bucket dollars over `metrics.total{Input,Output,CacheRead,CacheWrite}CostUsd`.
    // Two completions; the reducer must add each bucket separately.
    const store = freshStore();
    const runId = await seedRun(store);
    const s0 = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: s0.workflowSha, contractVersion: s0.contractVersion, startNode: "a" },
        },
      ],
      s0.version,
    );
    const s1 = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.node_completed",
          payload: {
            nodeId: "a",
            iteration: 0,
            tokens: 100,
            costUsd: 0.01,
            inputCostUsd: 0.003,
            outputCostUsd: 0.005,
            cacheReadCostUsd: 0.0005,
            cacheWriteCostUsd: 0.0015,
            nextNode: "b",
          },
        },
        {
          type: "fact.node_completed",
          payload: {
            nodeId: "b",
            iteration: 0,
            tokens: 50,
            costUsd: 0.005,
            inputCostUsd: 0.001,
            outputCostUsd: 0.002,
            cacheReadCostUsd: 0.0008,
            cacheWriteCostUsd: 0.0012,
            nextNode: "c",
          },
        },
      ],
      s1.version,
    );
    const s2 = store.getState(runId)!;
    expect(s2.metrics.totalInputCostUsd).toBeCloseTo(0.004, 6);
    expect(s2.metrics.totalOutputCostUsd).toBeCloseTo(0.007, 6);
    expect(s2.metrics.totalCacheReadCostUsd).toBeCloseTo(0.0013, 6);
    expect(s2.metrics.totalCacheWriteCostUsd).toBeCloseTo(0.0027, 6);
    // The four splits sum to totalCostUsd within float rounding.
    const splitSum =
      s2.metrics.totalInputCostUsd +
      s2.metrics.totalOutputCostUsd +
      s2.metrics.totalCacheReadCostUsd +
      s2.metrics.totalCacheWriteCostUsd;
    expect(splitSum).toBeCloseTo(s2.metrics.totalCostUsd, 6);
    store.close();
  });

  test("fact.run_paused (payment_required) transitions status; fact.run_resumed wakes back to queued", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const s0 = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: s0.workflowSha, contractVersion: s0.contractVersion, startNode: "a" },
        },
      ],
      s0.version,
    );
    const s1 = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.run_paused",
          payload: {
            reason: "payment_required",
            nodeId: "a",
            provider: "anthropic",
            errorMessage: "Insufficient balance",
          },
        },
      ],
      s1.version,
    );
    const paused = store.getState(runId)!;
    expect(paused.status).toBe("paused");
    expect(paused.nodeStartedAt).toBeNull();

    store.appendFact(runId, [{ type: "fact.run_resumed", payload: { fromStatus: "paused" } }], paused.version);
    const resumed = store.getState(runId)!;
    expect(resumed.status).toBe("queued");
    store.close();
  });

  test("fact.run_paused (provider_error) accepts httpStatus=null for network errors", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const s0 = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: s0.workflowSha, contractVersion: s0.contractVersion, startNode: "a" },
        },
      ],
      s0.version,
    );
    const s1 = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.run_paused",
          payload: {
            reason: "provider_error",
            nodeId: "a",
            httpStatus: null,
            provider: "anthropic",
            errorMessage: "ECONNRESET",
          },
        },
      ],
      s1.version,
    );
    expect(store.getState(runId)!.status).toBe("paused");
    store.close();
  });

  test("appendFact rejects oversized payloads", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const s = store.getState(runId)!;
    const big = "x".repeat(MAX_EVENT_PAYLOAD_BYTES);
    expect(() =>
      store.appendFact(
        runId,
        [
          {
            type: "fact.run_halted",
            payload: { reason: "error", detail: big },
          },
        ],
        s.version,
      ),
    ).toThrow(PayloadTooLargeError);
    store.close();
  });
});

describe("SqliteStore — intents", () => {
  test("appendIntent lands in the event log, does not change version", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const s = store.getState(runId)!;
    const intent: IntentEvent = {
      type: "intent.pause_requested",
      payload: {},
    };
    const { seq } = store.appendIntent(runId, intent);
    expect(seq).toBeGreaterThan(0);
    expect(store.getState(runId)!.version).toBe(s.version);
    const unapplied = store.getUnappliedIntents(runId);
    expect(unapplied.some((e) => e.type === "intent.pause_requested")).toBe(true);
    store.close();
  });

  test("intent.resume round-trips through the event log", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const intent: IntentEvent = { type: "intent.resume", payload: { note: "topped up balance" } };
    const { seq } = store.appendIntent(runId, intent);
    expect(seq).toBeGreaterThan(0);
    const unapplied = store.getUnappliedIntents(runId);
    const resume = unapplied.find((e) => e.type === "intent.resume");
    expect(resume?.payload).toEqual({ note: "topped up balance" });
    store.close();
  });
});

describe("SqliteStore — appendObservabilityEvents", () => {
  test("writes events verbatim with monotonically increasing seqs, doesn't bump version", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const before = store.getState(runId)!;

    const res = store.appendObservabilityEvents(runId, [
      { type: "agent.turn_start", payload: { nodeId: "n1", iteration: 0, turnId: "t1" } },
      { type: "llm.text_delta", payload: { nodeId: "n1", iteration: 0, delta: "hel" } },
      { type: "llm.text_delta", payload: { nodeId: "n1", iteration: 0, delta: "lo" } },
      { type: "tool.execution_end", payload: { nodeId: "n1", iteration: 0, tool_name: "bash" } },
    ]);

    expect(res.seqs).toHaveLength(4);
    for (let i = 1; i < res.seqs.length; i++) {
      expect(res.seqs[i]!).toBeGreaterThan(res.seqs[i - 1]!);
    }
    expect(store.getState(runId)!.version).toBe(before.version);

    const events = store.getEvents(runId);
    const types = events.map((e) => e.type);
    expect(types).toContain("agent.turn_start");
    expect(types.filter((t) => t === "llm.text_delta")).toHaveLength(2);
    expect(types).toContain("tool.execution_end");
    store.close();
  });

  test("empty array is a no-op — no seqs, no writes", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const before = store.getEvents(runId).length;
    const res = store.appendObservabilityEvents(runId, []);
    expect(res.seqs).toEqual([]);
    expect(store.getEvents(runId).length).toBe(before);
    store.close();
  });

  test("observability seqs interleave with facts in commit order", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const s = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: "wf", contractVersion: CURRENT_SCHEMA_VERSION, startNode: "n1" },
        },
      ],
      s.version,
    );
    const obs1 = store.appendObservabilityEvents(runId, [
      { type: "llm.text_delta", payload: { nodeId: "n1", iteration: 0, delta: "a" } },
    ]);
    const obs2 = store.appendObservabilityEvents(runId, [
      { type: "llm.text_delta", payload: { nodeId: "n1", iteration: 0, delta: "b" } },
    ]);
    expect(obs2.seqs[0]!).toBeGreaterThan(obs1.seqs[0]!);
    store.close();
  });

  test("rejects an event with an empty type string", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    expect(() => store.appendObservabilityEvents(runId, [{ type: "", payload: {} }])).toThrow();
    store.close();
  });

  test("rejects writes to unknown runId", async () => {
    const store = freshStore();
    expect(() => store.appendObservabilityEvents("no-such-run", [{ type: "llm.text_delta", payload: {} }])).toThrow();
    store.close();
  });

  test("oversized payload is truncated, not rejected — keeps batch flowing", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const huge = "x".repeat(8000);
    const res = store.appendObservabilityEvents(runId, [
      { type: "agent.turn_start", payload: { nodeId: "n1", iteration: 0 } },
      { type: "llm.start", payload: { nodeId: "n1", iteration: 0, system_prompt: huge } },
      { type: "llm.text_delta", payload: { nodeId: "n1", iteration: 0, delta: "ok" } },
    ]);
    expect(res.seqs).toHaveLength(3);
    const events = store.getEvents(runId);
    const llmStart = events.find((e) => e.type === "llm.start");
    expect(llmStart).toBeDefined();
    const payload = llmStart!.payload as Record<string, unknown>;
    expect(payload["_truncated"]).toBe(true);
    expect(payload["_original_bytes"]).toBeGreaterThan(4096);
    expect(payload["nodeId"]).toBe("n1");
    expect(payload["iteration"]).toBe(0);
    expect(payload["system_prompt"]).toBeUndefined();
    store.close();
  });

  test("truncation preserves provider / model / thread_id / summary on llm.start", async () => {
    // Without these fields the step inspector can't render the model
    // name, look up the context window, or join back to the right
    // thread — and the screenshot bug was: long-prompt steps showed up
    // with model=null because truncation silently dropped them.
    const store = freshStore();
    const runId = await seedRun(store);
    const huge = "x".repeat(8000);
    store.appendObservabilityEvents(runId, [
      {
        type: "llm.start",
        payload: {
          nodeId: "implement",
          iteration: { n: 1, max: 3 },
          provider: "ppq",
          model: "claude-sonnet-4.6",
          thread_id: "dev",
          summary: "medium",
          prompt: huge,
          system_prompt: huge,
        },
      },
    ]);
    const events = store.getEvents(runId);
    const llmStart = events.find((e) => e.type === "llm.start")!;
    const payload = llmStart.payload as Record<string, unknown>;
    expect(payload["_truncated"]).toBe(true);
    expect(payload["nodeId"]).toBe("implement");
    expect(payload["provider"]).toBe("ppq");
    expect(payload["model"]).toBe("claude-sonnet-4.6");
    expect(payload["thread_id"]).toBe("dev");
    expect(payload["summary"]).toBe("medium");
    // Loop iteration object survives in its `{ n, max }` shape.
    expect(payload["iteration"]).toEqual({ n: 1, max: 3 });
    // Bulky fields are still dropped.
    expect(payload["prompt"]).toBeUndefined();
    expect(payload["system_prompt"]).toBeUndefined();
    store.close();
  });
});

describe("SqliteStore — artifacts & blobs", () => {
  test("putArtifact dedups identical content into one blob", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const content = new TextEncoder().encode("hello");

    const a = store.putArtifact({ runId, nodeId: "n1", iteration: 0, key: "k" }, content, "text/plain");
    const b = store.putArtifact({ runId, nodeId: "n1", iteration: 1, key: "k" }, content, "text/plain");
    expect(a.sha256).toBe(b.sha256);

    const blobCount = (store as unknown as { db: import("bun:sqlite").Database }).db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM blobs")
      .get();
    expect(blobCount!.n).toBe(1);

    expect(new TextDecoder().decode(store.getArtifact(a))).toBe("hello");
    store.close();
  });

  test("loop iterations produce distinct artifact rows for same key", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    for (let i = 0; i < 3; i++) {
      store.putArtifact({ runId, nodeId: "loop", iteration: i, key: "out" }, new TextEncoder().encode(`iter-${i}`));
    }
    const rows = (store as unknown as { db: import("bun:sqlite").Database }).db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM artifacts WHERE run_id = ?")
      .get(runId)!;
    expect(rows.n).toBe(3);
    store.close();
  });

  test("oversize blob is rejected", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const big = new Uint8Array(MAX_BLOB_BYTES + 1);
    expect(() => store.putArtifact({ runId, nodeId: "n", iteration: 0, key: "k" }, big)).toThrow(ArtifactTooLargeError);
    store.close();
  });
});

describe("SqliteStore — routing bound", () => {
  test("enqueue with oversize initial routing throws", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    const huge: Record<string, string> = {
      bloat: "x".repeat(MAX_ROUTING_BYTES),
    };
    expect(() =>
      store.enqueueRun({
        runId: "r_bloat",
        workflowSha: sha,
        initialRouting: huge,
      }),
    ).toThrow(PayloadTooLargeError);
    store.close();
  });
});

describe("SqliteStore — daemon lock", () => {
  test("acquire is exclusive; force overrides", () => {
    const store = freshStore();
    const first = store.acquireDaemonLock(101, "host-a");
    expect(first.acquired).toBe(true);

    const second = store.acquireDaemonLock(202, "host-b");
    expect(second.acquired).toBe(false);
    expect(second.current.pid).toBe(101);

    store.forceAcquireDaemonLock(202, "host-b");
    expect(store.currentDaemonLock()!.pid).toBe(202);

    store.releaseDaemonLock(202);
    expect(store.currentDaemonLock()).toBeNull();
    store.close();
  });

  test("heartbeat advances heartbeat_at only for the current owner", () => {
    const store = freshStore();
    store.acquireDaemonLock(1, "h");
    const before = store.currentDaemonLock()!.heartbeatAt;
    store.heartbeatDaemonLock(1);
    const after = store.currentDaemonLock()!.heartbeatAt;
    expect(after).toBeGreaterThan(before);

    // Non-owner heartbeat is a no-op.
    store.heartbeatDaemonLock(9999);
    const unchanged = store.currentDaemonLock()!.heartbeatAt;
    expect(unchanged).toBe(after);
    store.close();
  });

  test("setServerEndpoint publishes discovery, independent of the daemon lock", () => {
    const store = freshStore();

    // No daemon lock needed: the endpoint is its own row (the CI primitive's
    // `serve` can publish before — or without — a daemon ever acquiring).
    store.setServerEndpoint({ url: "http://localhost:6767/api", port: 6767, pid: 1, version: "0.0.0" });
    const published = store.currentServerEndpoint()!;
    expect(published.url).toBe("http://localhost:6767/api");
    expect(published.port).toBe(6767);
    expect(published.pid).toBe(1);
    expect(published.harnessVersion).toBe("0.0.0");
    expect(store.currentDaemonLock()).toBeNull();
    store.close();
  });

  test("daemon-lock churn never clobbers the endpoint (separate rows)", () => {
    const store = freshStore();
    store.setServerEndpoint({ url: "http://localhost:6767/api", port: 6767, pid: 99, version: "0.0.0" });

    // A daemon restart (release + fresh acquire) churns daemon_lock, but the
    // endpoint row is untouched — no re-assert loop needed.
    store.acquireDaemonLock(1, "h");
    store.releaseDaemonLock(1);
    store.acquireDaemonLock(2, "h");
    expect(store.currentServerEndpoint()!.url).toBe("http://localhost:6767/api");
    store.close();
  });

  test("clearServerEndpoint is pid-scoped", () => {
    const store = freshStore();
    store.setServerEndpoint({ url: "http://localhost:6767/api", port: 6767, pid: 42, version: null });

    // A late closer with a stale pid (a server that already rebound) must not
    // erase the live endpoint.
    store.clearServerEndpoint(7);
    expect(store.currentServerEndpoint()).not.toBeNull();

    store.clearServerEndpoint(42);
    expect(store.currentServerEndpoint()).toBeNull();
    store.close();
  });
});

describe("SqliteStore — messages", () => {
  test("append and read back in ordinal order, AgentMessage round-trips", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendMessage(runId, {
      content: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
      nodeId: null,
      iteration: 0,
    });
    store.appendMessage(runId, {
      content: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        api: "anthropic" as never,
        provider: "anthropic" as never,
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
      nodeId: "a",
      iteration: 0,
    });
    const rows = store.getMessages(runId);
    expect(rows.map((r) => r.content.role)).toEqual(["user", "assistant"]);
    expect(rows[0]?.content).toMatchObject({ role: "user", content: [{ type: "text", text: "hi" }] });
    expect(rows[1]?.content).toMatchObject({ role: "assistant", content: [{ type: "text", text: "hello" }] });
    store.close();
  });

  test("opt-in dedup: identical content at same scope returns the same ordinal", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const msg = { role: "user" as const, content: [{ type: "text" as const, text: "deterministic" }], timestamp: 1 };
    const a = store.appendMessage(runId, { content: msg, nodeId: "n", iteration: 0 }, { dedup: true });
    const b = store.appendMessage(runId, { content: msg, nodeId: "n", iteration: 0 }, { dedup: true });
    expect(b.ordinal).toBe(a.ordinal);
    expect(store.getMessages(runId)).toHaveLength(1);
    // Different iteration → different scope → fresh ordinal even with dedup.
    const c = store.appendMessage(runId, { content: msg, nodeId: "n", iteration: 1 }, { dedup: true });
    expect(c.ordinal).not.toBe(a.ordinal);
    expect(store.getMessages(runId)).toHaveLength(2);
    // Default (no opts) keeps appending fresh ordinals — agent-message timestamps
    // make automatic dedup unsafe; the caller asserts replay-safety explicitly.
    const d = store.appendMessage(runId, { content: msg, nodeId: "n", iteration: 0 });
    expect(d.ordinal).not.toBe(a.ordinal);
    store.close();
  });

  test("appendMessage emits fact.message_appended carrying ordinal/role/nodeId/iteration", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const before = store.getEvents(runId).length;
    const r = store.appendMessage(runId, {
      content: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
      nodeId: "n1",
      iteration: 2,
    });
    const events = store.getEvents(runId);
    expect(events).toHaveLength(before + 1);
    const last = events[events.length - 1]!;
    expect(last.type).toBe("fact.message_appended");
    expect(last.writer).toBe("daemon");
    expect(last.payload).toEqual({ ordinal: r.ordinal, role: "user", nodeId: "n1", iteration: 2 });
    store.close();
  });

  test("appendMessage dedup hit does not emit a duplicate fact.message_appended", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const msg = { role: "user" as const, content: [{ type: "text" as const, text: "deterministic" }], timestamp: 1 };
    store.appendMessage(runId, { content: msg, nodeId: "n", iteration: 0 }, { dedup: true });
    const after1 = store.getEvents(runId).length;
    store.appendMessage(runId, { content: msg, nodeId: "n", iteration: 0 }, { dedup: true });
    expect(store.getEvents(runId).length).toBe(after1);
    store.close();
  });
});

describe("SqliteStore — message size bound", () => {
  test(`appendMessage throws MessageTooLargeError at ${MAX_MESSAGE_CONTENT_BYTES} bytes`, async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    // Build a message whose JSON-serialized size exceeds the cap. The
    // inner text field is filler; the role/content shape is irrelevant for
    // the size check.
    const filler = "x".repeat(MAX_MESSAGE_CONTENT_BYTES);
    expect(() =>
      store.appendMessage(runId, {
        content: { role: "user", content: [{ type: "text", text: filler }], timestamp: 1 },
        nodeId: null,
        iteration: 0,
      }),
    ).toThrow(MessageTooLargeError);
    // Nothing was inserted.
    expect(store.getMessages(runId)).toHaveLength(0);
    store.close();
  });

  test("messages just under the cap succeed", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    // Leave headroom for JSON overhead (role, timestamp, content wrapper).
    const filler = "x".repeat(MAX_MESSAGE_CONTENT_BYTES - 256);
    store.appendMessage(runId, {
      content: { role: "user", content: [{ type: "text", text: filler }], timestamp: 1 },
      nodeId: null,
      iteration: 0,
    });
    expect(store.getMessages(runId)).toHaveLength(1);
    store.close();
  });
});

describe("SqliteStore — listThreadsWithMessages", () => {
  test("returns distinct (runId, threadId) pairs from messages' node_id and llm.start thread_id", async () => {
    const store = freshStore();
    const r1 = await seedRun(store, { runId: "run-a" });
    const r2 = await seedRun(store, { runId: "run-b" });

    const userMsg = { role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: 1 };
    store.appendMessage(r1, { content: userMsg, nodeId: "implement", iteration: 0 });
    store.appendMessage(r1, { content: userMsg, nodeId: "implement", iteration: 0 });
    store.appendMessage(r1, { content: userMsg, nodeId: "verify", iteration: 0 });
    store.appendMessage(r2, { content: userMsg, nodeId: "plan", iteration: 0 });
    store.appendMessage(r2, { content: userMsg, nodeId: null, iteration: 0 });

    store.appendObservabilityEvents(r1, [
      { type: "llm.start", payload: { nodeId: "implement", iteration: 0, thread_id: "dev" } },
      { type: "llm.start", payload: { nodeId: "verify", iteration: 0, thread_id: "dev" } },
    ]);

    const rows = store.listThreadsWithMessages();
    const set = new Set(rows.map((r) => `${r.runId}::${r.threadId}`));
    expect(set.has("run-a::implement")).toBe(true);
    expect(set.has("run-a::verify")).toBe(true);
    expect(set.has("run-a::dev")).toBe(true);
    expect(set.has("run-b::plan")).toBe(true);
    expect(set.size).toBe(4);
    store.close();
  });

  test("excludes terminal runs (completed / cancelled / halted)", async () => {
    const store = freshStore();
    const live = await seedRun(store, { runId: "live" });
    const done = await seedRun(store, { runId: "done" });

    const userMsg = { role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: 1 };
    store.appendMessage(live, { content: userMsg, nodeId: "t1", iteration: 0 });
    store.appendMessage(done, { content: userMsg, nodeId: "t1", iteration: 0 });

    const s = store.getState(done)!;
    store.appendFact(
      done,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: s.workflowSha, contractVersion: s.contractVersion, startNode: "a" },
        },
      ],
      s.version,
    );
    const s1 = store.getState(done)!;
    store.appendFact(done, [{ type: "fact.run_completed", payload: { finalNode: "a" } }], s1.version);

    const rows = store.listThreadsWithMessages();
    const runIds = new Set(rows.map((r) => r.runId));
    expect(runIds.has("live")).toBe(true);
    expect(runIds.has("done")).toBe(false);
    store.close();
  });

  test("no messages, no llm.start events → empty array", async () => {
    const store = freshStore();
    await seedRun(store);
    expect(store.listThreadsWithMessages()).toEqual([]);
    store.close();
  });

  test("paused_human runs are included", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const userMsg = { role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: 1 };
    store.appendMessage(runId, { content: userMsg, nodeId: "t1", iteration: 0 });
    const s = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: s.workflowSha, contractVersion: s.contractVersion, startNode: "a" },
        },
      ],
      s.version,
    );
    const s1 = store.getState(runId)!;
    store.appendFact(
      runId,
      [{ type: "fact.run_paused_human", payload: { nodeId: "a", text: "p", routes: [] } }],
      s1.version,
    );
    expect(store.getState(runId)!.status).toBe("paused_human");
    const rows = store.listThreadsWithMessages();
    expect(rows.some((r) => r.runId === runId && r.threadId === "t1")).toBe(true);
    store.close();
  });

  test("paused (payment_required) runs are included (resumable thread)", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const userMsg = { role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: 1 };
    store.appendMessage(runId, { content: userMsg, nodeId: "t1", iteration: 0 });
    const s = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: s.workflowSha, contractVersion: s.contractVersion, startNode: "a" },
        },
      ],
      s.version,
    );
    const s1 = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.run_paused",
          payload: {
            reason: "payment_required",
            nodeId: "a",
            provider: "anthropic",
            errorMessage: "Insufficient balance",
          },
        },
      ],
      s1.version,
    );
    expect(store.getState(runId)!.status).toBe("paused");
    const rows = store.listThreadsWithMessages();
    expect(rows.some((r) => r.runId === runId && r.threadId === "t1")).toBe(true);
    store.close();
  });
});

describe("SqliteStore — gcBlobs", () => {
  test("deletes orphan blobs, preserves referenced ones", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const ref = store.putArtifact({ runId, nodeId: "n", iteration: 0, key: "k" }, new TextEncoder().encode("keep"));
    // Inject an orphan blob row directly.
    const db = (store as unknown as { db: Database }).db;
    db.query("INSERT INTO blobs (sha256, size_bytes, created_at) VALUES (?, ?, ?)").run("orphan-sha", 3, 1);

    const { deleted } = store.gcBlobs();
    expect(deleted).toBeGreaterThanOrEqual(1);

    const remain = db
      .query<{ sha256: string }, []>("SELECT sha256 FROM blobs")
      .all()
      .map((r) => r.sha256);
    expect(remain).toContain(ref.sha256);
    expect(remain).not.toContain("orphan-sha");
    store.close();
  });

  test("sweeps orphan blob files with no matching row", async () => {
    const store = freshStore();
    const blobs = (store as unknown as { blobs: BlobFS }).blobs;
    const stray = "a".repeat(64);
    blobs.put(stray, new Uint8Array([9, 9, 9]));
    expect(blobs.has(stray)).toBe(true);
    store.gcBlobs();
    expect(blobs.has(stray)).toBe(false);
    store.close();
  });
});

describe("SqliteStore — getLatestLifecycleByNode", () => {
  test("returns the latest lifecycle fact TYPE per node; non-lifecycle and node-less events are ignored", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const append = (fact: FactEvent) => {
      const v = store.getState(runId)!.version;
      store.appendFact(runId, [fact], v);
    };
    append({ type: "fact.run_started", payload: { workflowSha: "wf", contractVersion: 1, startNode: "a" } });
    append({ type: "fact.dispatch_started", payload: { nodeId: "a", iteration: 0, resumeOf: "fresh" } });
    append({ type: "fact.dispatch_started", payload: { nodeId: "b", iteration: 0, resumeOf: "fresh" } });
    append({
      type: "fact.node_completed",
      payload: { nodeId: "a", iteration: 0, tokens: 0, costUsd: 0, nextNode: "j" },
    });
    append({
      type: "fact.node_aborted",
      payload: { nodeId: "b", iteration: 0, cause: "aborted", partialTokens: 0, partialCostUsd: 0 },
    });
    // Interleaved observability under a node id must not displace the fact.
    store.appendObservabilityEvents(runId, [{ type: "llm.start", payload: { nodeId: "b", model: "m" } }]);

    const latest = new Map(store.getLatestLifecycleByNode(runId).map((r) => [r.nodeId, r.type]));
    expect(latest.get("a")).toBe("fact.node_completed");
    expect(latest.get("b")).toBe("fact.node_aborted");
    expect(latest.has("j")).toBe(false);
    store.close();
  });

  test("empty log → empty result", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    expect(store.getLatestLifecycleByNode(runId)).toEqual([]);
    store.close();
  });
});
